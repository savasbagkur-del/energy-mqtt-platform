# Saha Test Runbook — Gerçek Cihaz (SN 24042809890002) @ Canlı AWS EMQX

Amaç: dayanıklı komut + reconcile + verify zincirini **gerçek fiziksel cihaza** karşı, **canlı
broker** üzerinde, gerçek cihaz kararsızlığı altında doğrulamak. "Asla pes etmeyen" davranışı
(retry/backoff, ACK gelmeyince yeniden gönderim, telemetri ile doğrulama) sahada görmek.

> Bu cihaz için ayrı, sabırlı bir politika profili zaten var: `saha_sn_24042809890002`
> (migration `0013`). single-flight + switch sonrası otomatik refresh + patient ack/verify.

---

## 0. GÜVENLİK İLKELERİ (her koşuda geçerli)

1. **DB izolasyonu:** test worker'ı **yerel** Postgres'e yazar (`localhost:5433`), **canlı DB'ye
   DEĞİL**. Test iradesi/komutları production verisini kirletmez.
2. **Paylaşımlı grup YOK:** `MQTT_SHARED_GROUP` **boş** bırakılır. Exclusive abonelik kendi
   mesaj kopyasını alır → canlı worker'ların paylaşımlı grubundan mesaj **çalmaz**. Canlı sistem
   etkilenmez.
3. **`clean:true`:** `MQTT_CLEAN_SESSION=true`. Test client disconnect olunca broker'da sonsuza
   dek kuyruk biriken kalıcı oturum **bırakmaz** (broker bellek koruması).
4. **Benzersiz client id:** `MQTT_CLIENT_ID=saha-test-reconciler-01` (canlı worker id'leriyle
   çakışmaz).
5. **Fiziksel etki:** force-switch **gerçek sayaç rölesini fiziksel olarak açar/kapatır.** Aşama
   2'ye yalnızca operatör onayı + cihaz başında gözlemle geçilir.
6. **Tek worker:** yalnızca bir test worker'ı çalıştırılır.

Cihaz bilgisi:
- `SN = 24042809890002`
- `productKey = NzIxOTYzNTc4MDEwNDMxNDg4`
- Komut topic'i: `indicate/server/NzIxOTYzNTc4MDEwNDMxNDg4/24042809890002`
- ACK topic'i: `indicate/dev/NzIxOTYzNTc4MDEwNDMxNDg4/24042809890002`
- Telemetri: `data/up/NzIxOTYzNTc4MDEwNDMxNDg4/24042809890002`

---

## 1. Hazırlık

```powershell
# Yerel stack ayakta mı? (sadece Postgres gerekli; EMQX gerekmez — canlı broker kullanacağız)
docker compose up -d postgres
# Migrasyonlar (saha politikası dahil) uygulanmış olmalı:
corepack pnpm --filter @communication/db migrate
```

---

## 2. AŞAMA 1 — SADECE GÖZLEM (yan etki YOK)

Reconciler kapalı; worker yalnızca canlı broker'a bağlanır ve gerçek cihazın login/telemetri
akışını **yerel DB'ye** yazar. Hiçbir komut publish edilmez.

```powershell
$env:SIMULATOR_MODE="false"
$env:RECONCILE_ENABLED="false"          # <-- yan etki yok
$env:MQTT_SHARED_GROUP=""               # <-- exclusive (paylaşımsız), trafik çalmaz
$env:MQTT_CLEAN_SESSION="true"          # <-- kalıcı oturum bırakma
$env:MQTT_CLIENT_ID="saha-test-reconciler-01"
$env:LOG_LEVEL="info"
# Canlı broker (.env'den) — açıkça veriyoruz:
$env:MQTT_HOST="51.20.106.176"; $env:MQTT_PORT="1883"
$env:MQTT_USERNAME="worker_live_01"; $env:MQTT_PASSWORD="<.env'deki sifre>"
# Yerel DB:
$env:POSTGRES_HOST="localhost"; $env:POSTGRES_PORT="5433"
$env:POSTGRES_DB="communication"; $env:POSTGRES_USER="postgres"; $env:POSTGRES_PASSWORD="postgres"
corepack pnpm --filter mqtt-worker dev
```

**Doğrulama (kritik nokta):** birkaç dakika içinde gerçek cihazın mesajları gelmeli.

```sql
-- Yerel DB'de gerçek cihaz görünüyor mu?
SELECT sn, last_method, last_topic, switch_state, last_seen_at
FROM device_latest_state WHERE sn = '24042809890002';

SELECT method, topic, created_at FROM telemetry_raw
WHERE sn = '24042809890002' ORDER BY created_at DESC LIMIT 5;
```

- Mesaj geliyorsa: bağlantı + abonelik + parse + ingest canlıda çalışıyor. ✅
- **STOP & CHECK:** mevcut `switch_state` değerini not al (cihaz şu an açık mı kapalı mı?).

---

## 3. AŞAMA 2 — TEK KONTROLLÜ ANAHTARLAMA (fiziksel etki, onay sonrası)

> Yalnızca operatör cihaz başında ve onay verdikten sonra. Bir karşıt hedef seçilir (örn. cihaz
> şu an AÇIK ise hedef KAPALI).

Aynı worker'ı **reconcile AÇIK** ile yeniden başlat:

```powershell
$env:RECONCILE_ENABLED="true"
$env:RECONCILE_INTERVAL_MS="5000"
$env:DEVICE_ONLINE_TTL_SEC="600"
# (diğer env Aşama 1 ile aynı)
corepack pnpm --filter mqtt-worker dev
```

İradeyi yerel DB'ye yaz (API ile veya SQL ile). Örn. KAPALI hedefi:

```sql
INSERT INTO device_desired_state (sn, product_key, capability, desired_value, reconcile_status, next_eval_at)
VALUES ('24042809890002', 'NzIxOTYzNTc4MDEwNDMxNDg4', 'switch', '{"switch":0}'::jsonb, 'pending', NOW())
ON CONFLICT (sn, capability) DO UPDATE SET
  desired_value = EXCLUDED.desired_value, reconcile_status='pending',
  reported_value=NULL, reconciled_at=NULL, attempt_count=0, next_eval_at=NOW();
```

**İzlenecekler (canlı zincir):**
1. `reconcile_command_issued` → force_switch komutu üretildi.
2. `publish_outbound` → komut `indicate/server/...` topic'ine gönderildi (gerçek cihaza).
3. Cihaz `indicate/dev/...` ile ACK döner → `ack_received`.
4. Otomatik refresh + `data/up` telemetrisinde `SwitchSta` hedefe eşit → `verified_success`.
5. Reconciler `reconciled` (telemetri-tetikli; backoff beklemeden).
6. **Fiziksel doğrulama:** sayaç rölesi gerçekten hedefe geçti mi?

**Kararsızlık senaryosu (asıl test):** cihaz ACK'i geç verirse / cycle atlarsa, retry/backoff'un
devreye girip komutu yeniden gönderdiğini ve telemetri gelince doğruladığını gözle. ACK hiç
gelmezse `delivery_timeout` + reconciler'ın iradeyi `unreachable` yapıp backoff ile sürdürmesi
(asla pes etmeme) beklenir.

```sql
-- Komut yaşam döngüsü:
SELECT ce.event_type, ce.created_at, ce.payload
FROM command_events ce JOIN commands c ON c.id=ce.command_id
WHERE c.sn='24042809890002' ORDER BY ce.created_at DESC LIMIT 30;

-- İrade durumu:
SELECT reconcile_status, attempt_count, reported_value, next_eval_at
FROM device_desired_state WHERE sn='24042809890002';
```

---

## 4. Temizlik

```powershell
# Worker'ı durdur (Ctrl+C). clean:true olduğu için broker'da oturum kalmaz.
```

```sql
-- Test iradesini geri al (isteğe bağlı):
DELETE FROM device_desired_state WHERE sn='24042809890002';
```

> Not: Aşama 2 sayacın fiziksel durumunu değiştirir. Testi cihazı bilinen/istenen durumda
> bırakacak şekilde sonlandır.
