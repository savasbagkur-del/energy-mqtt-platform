# Faz 1 Test Runbook — Dayanıklı İrade (Desired-State) + Reconciler + Presence

Bu runbook, sistemi sıfırdan ayağa kaldırıp **kritik noktalarda durup kontrol** ederek ilerlemen
için yazıldı. Her adımda bir **"DUR & KONTROL ET"** kutusu var; orada beklenen çıktıyı görmezsen
devam etme, bana söyle — bağlantı/kopma sorunlarını erkenden yakalayalım.

Komutlar PowerShell içindir. Repo kökü: `c:\projeler\energy-mqtt-platform`.

---

## 0) Ön koşul: Docker Desktop motoru

Docker Desktop'ı aç ve sistem tepsisindeki balina ikonu **yeşil/Running** olana kadar bekle.
Sonra doğrula:

```powershell
docker info --format "{{.ServerVersion}}"
```

> **DUR & KONTROL ET:** Bir sürüm numarası dönmeli (örn. `27.x`). "unable to start" / hata
> dönüyorsa motor hazır değildir; Docker Desktop'ı yeniden başlat. Bu adım geçmeden ilerleme.

---

## 1) Altyapıyı başlat (Postgres + EMQX)

```powershell
docker compose up -d
docker compose ps
```

> **DUR & KONTROL ET (kritik — broker & DB bağlantısı):**
> - `communication-postgres` → `healthy`
> - `communication-emqx` → `healthy`
>
> EMQX panosu: http://localhost:18083 (kullanıcı `admin`, şifre compose'daki `MQTT_PASSWORD`).
> Açılıyorsa broker ayakta demektir.

---

## 2) Şemayı migrate et (Faz 1 tabloları)

```powershell
corepack pnpm --filter @communication/db migrate
```

> **DUR & KONTROL ET:** Log'da en az şunu görmelisin:
> `[db:migrate] applied { file: '0016_desired_state_presence.sql' }`
> ve sonda `[db:migrate] completed`.
>
> Tabloları doğrula:
> ```powershell
> docker exec -it communication-postgres psql -U postgres -d communication -c "\dt device_desired_state; \dt device_presence; \dt mqtt_client_bindings;"
> ```
> Üç tablo da listelenmeli.

---

## 3) Derle + birim testleri (kod sağlığı)

```powershell
corepack pnpm -r build
corepack pnpm --filter mqtt-worker test
```

> **DUR & KONTROL ET:** Build hatasız bitmeli; testlerde `pass 16  fail 0` görmelisin
> (reconciler karar + backoff ispatları dahil).

---

## 4) Worker'ı SİMÜLATÖR modunda başlat (cihaz olmadan uçtan uca)

Ayrı bir terminalde:

```powershell
$env:SIMULATOR_MODE="true"; $env:LOG_LEVEL="debug"; corepack pnpm --filter mqtt-worker dev
```

> **DUR & KONTROL ET (kritik — broker bağlantısı):** Worker boot log'unda MQTT'ye bağlandığını
> ve `mqttQos`, `mqttCleanSession`, `reconcileEnabled` gibi alanları görmelisin. Bağlantı
> koparsa burada hemen görünür.

Başka bir terminalde API'yi başlat:

```powershell
$env:SIMULATOR_MODE="true"; corepack pnpm --filter api dev
```

---

## 5) İrade testi — "cevap gelene kadar tut" (mutlu yol)

Önce bir cihazın simülatöre login olması için kısa bir süre bekle (worker simülatörde cihaz
durumunu komut geldikçe öğrenir). Test cihazı SN'sini kendi ortamından seç; aşağıda `SN123` örnektir.

Kapat (switch = 0) iradesini yaz:

```powershell
curl.exe -s -X POST http://localhost:3000/devices/SN123/commands/force-switch-0 | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

Beklenen: `202` ve `mode: "desired_state"`, `desiredState.reconcile_status: "pending"`.

Birkaç saniye sonra durumu sorgula:

```powershell
curl.exe -s http://localhost:3000/devices/SN123/desired | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

> **DUR & KONTROL ET (kritik — komut/cevap zinciri):**
> Worker log'unda sırasıyla `reconcile_command_issued` → (simülatör ACK + data/up update) →
> bir sonraki t<br>turda `reconcile_done` görmelisin. `GET .../desired` çıktısında
> `reconcile_status` zamanla `pending`/`in_flight` → **`reconciled`** olmalı, `reported_value`
> `{ "switch": 0 }` olmalı. Bu, "yazdı–doğrulandı–iradeyi bıraktı" akışıdır.

Aç (switch = 1) ile tekrarla:

```powershell
curl.exe -s -X POST http://localhost:3000/devices/SN123/commands/force-switch-1 | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

---

## 6) Supersede testi — fikir değiştirme (eski emir iptal)

Hızlıca önce kapat, hemen ardından aç gönder:

```powershell
curl.exe -s -X POST http://localhost:3000/devices/SN123/commands/force-switch-0 > $null
curl.exe -s -X POST http://localhost:3000/devices/SN123/commands/force-switch-1 | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

> **DUR & KONTROL ET:** İkinci yanıtta `superseded: true` ve `cancelledCommandIds` dolu olabilir
> (uçuştaki eski "kapat" komutu iptal edilir). Sonuçta cihaz **son** iradeye (aç=1) yakınsamalı.
> Aynı anda iki çelişen emir kalmaz — tek uçuş (single-flight) korunur.

---

## 7) Offline / "kopma" testi — vazgeçmeme davranışı (kritik)

Simülatörü/aboneliği bir cihaz için sustur (örn. worker'ı durdur ya da o cihazdan telemetri
kesilsin), sonra bir irade yaz:

```powershell
curl.exe -s -X POST http://localhost:3000/devices/SN123/commands/force-switch-0 > $null
# DEVICE_ONLINE_TTL_SEC süresi (varsayılan 600sn) geçince cihaz offline sayılır.
curl.exe -s http://localhost:3000/devices/SN123/desired | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

> **DUR & KONTROL ET (kritik — kopma toleransı):** Cihaz erişilemezken `reconcile_status`
> **`unreachable`** olur; worker log'unda artan backoff ile `reconcile_unreachable` tekrarları
> görünür. **İrade silinmez, sistem vazgeçmez.** Cihaz geri gelince (telemetri/presence tazelenince
> ya da EMQX `presence/connected` olayı düşünce) reconciler kaldığı yerden devam edip `reconciled`
> yapmalı. Test hızlandırmak için worker'ı `DEVICE_ONLINE_TTL_SEC=15` ile başlatabilirsin.

İptal etmek istersen (iradeyi tamamen bırak):

```powershell
curl.exe -s -X DELETE http://localhost:3000/devices/SN123/desired | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

---

## 8) EMQX presence + binding kuralları (gerçek topoloji)

Worker, EMQX rule-engine'in ürettiği şu topic'leri dinler:
- `presence/connected` / `presence/disconnected` → `device_presence` (online/offline)
- `meta/publish` → `mqtt_client_bindings` (clientid → product_key, sn; `sys/dev/#` lifecycle'inden öğrenilir)

Kuralları kurmak için (idempotent — varsa silip yeniden oluşturur):

```powershell
# Yerel broker (varsayilan)
node infra/emqx/setup-emqx-rules.mjs

# Uzak / production broker
$env:EMQX_API_URL="http://<broker-host>:18083"; $env:EMQX_API_USER="<dashboard-user>"; $env:EMQX_API_PASS="<dashboard-pass>"; node infra/emqx/setup-emqx-rules.mjs
```

Çıktıda 3 kuralın `applied ... enabled=true` olduğunu görmelisin.

> **DUR & KONTROL ET (kritik — presence/binding):** Bir MQTT istemcisi bir `clientid` ile bağlanıp
> `sys/dev/{productKey}/{sn}` topic'ine yayın yaptığında:
> - `mqtt_client_bindings` tablosuna `clientid → sn` satırı düşmeli (binding öğrenildi),
> - bağlantı/kopma olaylarında `device_presence` satırı `online`/`offline` olmalı,
> - worker log'unda `presence_event ... affectedSns:1` görünmeli.
>
> Kontrol:
> ```powershell
> docker exec -it communication-postgres psql -U postgres -d communication -c "SELECT * FROM mqtt_client_bindings;" -c "SELECT * FROM device_presence;"
> ```

Notlar:
- İlk bağlantıda binding henüz öğrenilmemişse o connect olayı bir sn'ye düşmeyebilir (`affectedSns:0`).
  `sys/dev/#` mesajı gelince binding öğrenilir; sonraki olaylar doğru çözülür. Ayrıca `clientid == sn`
  olan filolarda worker, ilgili cihaz kayıtlıysa `clientid`'yi doğrudan sn olarak kabul eder.
- `binding_learn` kuralı düşük frekanslı `sys/dev/#` lifecycle'ini kullanır (her telemetriyi değil),
  bu yüzden 10k cihazda broker yükü düşüktür.

## Notlar / sınırlar (testte birlikte göreceğiz, sonra ayarlarız)

- **Presence iki katmanlıdır:** (a) telemetri tazeliği (`devices.last_seen_at`, simülatörde de
  çalışır) + (b) opsiyonel EMQX `presence/#` connect/disconnect olayları. EMQX kuralı
  kurulmamışsa sistem yalnız telemetri tazeliğiyle çalışır — test için yeterli.
- **Gerçek `clientid → sn` eşlemesi** trafik üzerinden `mqtt_client_bindings` tablosuna öğrenilir
  (gateway/konsantratör uyumlu). EMQX `message.publish` kuralını `meta/#` topic'ine republish
  edecek şekilde kurarsan binding otomatik dolar; presence olayları o zaman doğru SN'lere düşer.
  Bu kuralı gerçek cihaz topolojini gördükten sonra netleştireceğiz.
- Reconciler her `RECONCILE_INTERVAL_MS`'de (varsayılan 5sn) çalışır; başarı koşulu
  `latest_state`'teki `SwitchSta == desired`. Komut yaşam döngüsünün (ACK/verify/late-confirm)
  kendi mantığı değişmedi; reconciler onun **üstünde** "irade" katmanıdır.
