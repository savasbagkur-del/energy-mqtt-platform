# Tasarım: Dayanıklı Komut Çekirdeği (Faz 0 + Faz 1)

> Amaç: Dengesiz cihazlarda **"komut cevap gelene kadar süresiz tutulur; sadece kullanıcı
> iptal eder ya da yeni bir irade gelirse bırakılır"** garantisini kurmak ve 10.000+ cihaz
> ölçeğine sağlam bir temel atmak.
>
> Kapsam: Faz 0 (sertleştirme) + Faz 1 (hedef-durum + reconciler + presence).
> Faz 2 (yatay ölçek), Faz 3 (çok-ürün driver), Faz 4 (güvenlik/ops) ayrı dokümanlarda.

---

## 0. Kavramsal Değişim

Bugün komut **geçici** bir varlık: `commands` satırı `delivery_window_sec` (720sn) içinde ACK
gelmezse `delivery_timeout` olur ve **pes eder**. Geç doğrulama yalnızca 1 saatlik pencerede
telemetriden teyit yakalayabilir.

Yeni modelde **kalıcı irade (desired state)** ile **geçici eylem (command)** ayrışır:

```
Kullanıcı (Ana Ekran)
      │  "SAYACI KAPAT"
      ▼
device_desired_state   ← KALICI İRADE  (sn + capability=switch → desired=0)
      │
      ▼  Reconciler (desired ≠ reported olduğu sürece çalışır)
commands               ← GEÇİCİ EYLEM  (mevcut force_switch pipeline'ı)
      │  publish → ack → verify
      ▼
device_latest_state    ← REPORTED (telemetri/ack'tan türetilen gerçek durum)
```

- Komut başarısız/timeout olsa bile **irade silinmez**. Reconciler cihaz online olduğunda
  yeni komut üretir. Bu, "cevap gelene kadar tut" davranışının kaynağıdır.
- Durma koşulları yalnızca: (a) `reported == desired` (reconciled), (b) kullanıcı iptali,
  (c) yeni/zıt irade (supersede).

---

## 1. Faz 0 — Sertleştirme (Reconciler'dan bağımsız, hemen değer)

### 1.1 MQTT QoS & kalıcı oturum
Dosya: `apps/mqtt-worker/src/main.ts`

Mevcut:
```ts
const mqttOptions: IClientOptions = {
  clientId: env.clientId,
  reconnectPeriod: 3000,
  connectTimeout: 10_000,
  clean: true            // ← oturum kalıcı değil
};
client.subscribe([...SUB_TOPICS], { qos: 0 }, ...)   // ← QoS 0
client.publish(topic, payload, { qos: 0 }, ...)      // ← QoS 0
```

Hedef:
- `clean: false` + **sabit `clientId`** (env'den, instance başına benzersiz; ör. `worker-1`).
  Böylece worker kopduğunda broker mesajları oturum kuyruğunda tutar.
- Subscribe **QoS 1**, command publish **QoS 1** (en az bir kez teslim).
- Cihaza giden komutlar için `qos: 1`; handshake (login/time/topology) cevapları QoS 0 kalabilir
  (idempotent ve cihaz tekrar sorar).

> Not (Faz 2 önkoşulu): `clean:false` tek-worker için doğrudur. Yatay ölçekte shared
> subscription kullanılacağı için o aşamada oturum/temizlik politikası yeniden değerlendirilecek.

### 1.2 Idempotent / güvenli publish
Dosya: `packages/db/src/commands.ts` (`claimCommandsForPublish`, `updateCommandStatus`)

Mevcut akışta claim transaction'ı `status='published'`, `attempt_count+1`, `published_at=NOW()`
ve `delivery_window_anchor_at` set ediyor; **sonra** MQTT publish yapılıyor. Worker iki adım
arasında çökerse satır "published" görünür ama mesaj gitmemiştir → ACK timeout retry kurtarır
(kabul edilebilir). Faz 0'da hafif sertleştirme:
- `commands` tablosuna `last_publish_attempt_at TIMESTAMPTZ` eklenir; gerçek `client.publish`
  başarısından sonra güncellenir (gözlemlenebilirlik + ileride outbox'a köprü).
- `delivery_window_anchor_at` zaten `COALESCE(..., NOW())` ile yalnızca ilk publish'te sabitleniyor — korunur.

### 1.3 İndeksler (ACK eşleştirme ve reconciler için)
Yeni migration:
```sql
-- ACK eşleştirme sorguları (findCommandForAck: sn + method + status='published')
CREATE INDEX IF NOT EXISTS idx_commands_sn_method_status
  ON commands (sn, method, status);

-- Single-flight alt sorgusu için (sn + status filtreleri)
CREATE INDEX IF NOT EXISTS idx_commands_sn_status_active
  ON commands (sn, status)
  WHERE status IN ('created','scheduled','published','ack_received','verify_pending');
```

### 1.4 Yapısal loglama
Yeni: `packages/core/src/logger.ts` (pino tabanlı). Mesaj başına `console.log` firehose'u
seviyeli/örneklemeli loglamayla değiştirilir. `LOG_LEVEL` env. `command-observability.ts`
çağrıları logger'a yönlendirilir. (Faz 0'da köprü; tüm console.log'ları toplu değiştirmek
opsiyonel ve aşamalı.)

---

## 2. Faz 1 — Hedef-Durum + Reconciler + Presence

### 2.1 Şema

#### `device_desired_state` (yeni tablo)
```sql
CREATE TABLE IF NOT EXISTS device_desired_state (
  id              BIGSERIAL PRIMARY KEY,
  sn              TEXT NOT NULL,
  product_key     TEXT NULL,
  capability      TEXT NOT NULL,              -- 'switch' (ileride çok-ürün için genişler)
  desired_value   JSONB NOT NULL,             -- ör. {"switch": 0}
  reported_value  JSONB NULL,                 -- son bilinen gerçek durum
  reconcile_status TEXT NOT NULL DEFAULT 'pending',
                  -- pending | in_flight | reconciled | unreachable | superseded | cancelled
  desired_set_by  TEXT NULL,                  -- kullanıcı/sistem
  desired_set_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_command_id BIGINT NULL REFERENCES commands(id) ON DELETE SET NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0, -- bu irade için üretilen komut sayısı
  last_attempt_at TIMESTAMPTZ NULL,
  next_eval_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- reconciler ne zaman tekrar baksın
  reconciled_at   TIMESTAMPTZ NULL,
  unreachable_since TIMESTAMPTZ NULL,         -- alarm/operatör görünürlüğü için
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_desired_state_sn_capability
  ON device_desired_state (sn, capability);

CREATE INDEX IF NOT EXISTS idx_device_desired_state_eval
  ON device_desired_state (reconcile_status, next_eval_at)
  WHERE reconcile_status IN ('pending','in_flight','unreachable');
```

> Cihaz başına (sn, capability) tek satır. "switch" tek başlangıç yeteneği; çok-ürün için
> ileride `capability` çeşitlenir (ör. `relay_2`, `setpoint`).

#### `device_presence` (yeni tablo)
```sql
CREATE TABLE IF NOT EXISTS device_presence (
  sn               TEXT PRIMARY KEY,
  status           TEXT NOT NULL,             -- 'online' | 'offline'
  connected_at     TIMESTAMPTZ NULL,
  disconnected_at  TIMESTAMPTZ NULL,
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source           TEXT NULL,                 -- 'mqtt_event' | 'lwt' | 'telemetry'
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `command_policy_profiles` eklemeleri (reconciler ayarları)
```sql
ALTER TABLE command_policy_profiles
  ADD COLUMN IF NOT EXISTS reconcile_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reconcile_min_backoff_sec INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reconcile_max_backoff_sec INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS reconcile_unreachable_alarm_sec INTEGER NOT NULL DEFAULT 1800;
```
- `reconcile_min/max_backoff_sec`: ardışık komut denemeleri arası backoff aralığı (exponential + jitter, max ile sınırlı).
- `reconcile_unreachable_alarm_sec`: bu süredir reconcile olamayan cihaz için **alarm event'i** (retry durmaz, sadece görünürlük).

### 2.2 Presence entegrasyonu (EMQX)

İki sinyal kaynağı (ikisi birlikte):

1. **EMQX client connect/disconnect olayları** (otoritatif, ana kaynak):
   - EMQX 5 rule engine ile `$events/client_connected` ve `$events/client_disconnected`
     olayları normal bir topic'e republish edilir, ör:
     `presence/connected/{clientid}` ve `presence/disconnected/{clientid}`.
   - Worker bu topic'lere abone olur (`presence/#`), `clientid → sn` eşlemesiyle
     `device_presence` günceller.
   - Alternatif (daha az tercih): EMQX webhook → API `/internal/presence` ucu.
2. **Cihaz LWT (Last Will & Testament)**: cihaz bağlanırken bir "will" mesajı tanımlar; broker
   beklenmedik kopmada otomatik yayınlar → `source='lwt'`.
3. **Telemetri yedeği**: `data/up` geldikçe `device_presence.status='online'`, `source='telemetry'`
   (olay kaçarsa son savunma). Mevcut `devices.last_seen_at` korunur ama artık otoritatif değil.

> MVP yolu: rule-engine republish + telemetri yedeği. LWT cihaz firmware'ine bağlı; opsiyonel.

**Reconciler tetikleme:** Bir `sn` için `online` olayı geldiğinde, o cihazın bekleyen
`device_desired_state` satırlarının `next_eval_at = NOW()` yapılır → cihaz döner dönmez anında denenir.

### 2.3 Reconciler döngüsü

Yeni dosya: `apps/mqtt-worker/src/reconciler.ts`. Worker'ın `setInterval` döngüsüne eklenir
(ör. 5sn'de bir; komut dispatch 1.5sn'de kalır).

```
processDesiredStateReconciliation():
  rows = selectDueDesiredStates(limit=200)   // status ∈ {pending,in_flight,unreachable} AND next_eval_at<=NOW()
  for row in rows:
    reported = resolveReportedValue(row.sn, row.capability)   // device_latest_state JSON'dan SwitchSta
    if reported == row.desired_value:
        mark RECONCILED (reconciled_at=NOW, unreachable_since=NULL)
        continue

    presence = getPresence(row.sn)
    if presence != 'online':
        mark UNREACHABLE (unreachable_since ??= NOW)
        next_eval_at = NOW + capped_backoff(attempt_count)   // online event gelince zaten erkene çekilir
        maybeEmitUnreachableAlarm(row)                       // reconcile_unreachable_alarm_sec aşıldıysa
        continue

    // online ve durum yanlış:
    inflight = getInFlightCommandForDevice(row.sn)            // single-flight: mevcut pipeline'a saygı
    if inflight:
        mark IN_FLIGHT; next_eval_at = NOW + ack/verify penceresine göre kısa bekleme
        continue

    // online + boşta + son komut yoksa veya terminal olduysa → yeni komut üret
    cmd = createReconcileCommand(row)        // desired.switch=0 → force_switch_0, =1 → force_switch_1
    row.last_command_id = cmd.id
    row.attempt_count += 1
    row.last_attempt_at = NOW
    mark IN_FLIGHT
    next_eval_at = NOW + capped_backoff(attempt_count)
    addEvent('reconcile_command_issued', {commandId, attempt})
```

**Backoff:** `capped_backoff = min(max_backoff, min_backoff * 2^(attempt-1)) ± jitter`.
Süre **sınırsız** denenir (forever-until-cancel); yalnızca backoff üst sınıra oturur.

**Mevcut komut motoruyla ilişki:**
- Reconciler **komut yaratıcısıdır**; gerçek publish/ack/verify yine `commands` pipeline'ında yürür.
- Komut `verified_success` olduğunda mevcut telemetri/ack yolu zaten `device_latest_state`'i
  günceller; reconciler bir sonraki turda `reported == desired` görür ve `RECONCILED` yapar.
- Komut `delivery_timeout`/`failed`/`verified_mismatch` olduğunda irade **silinmez**; reconciler
  backoff sonrası yeniden dener. Bu, mevcut "pes etme" davranışını iradeyle nötrler.

### 2.4 Supersede & iptal
- **Yeni/zıt irade:** Kullanıcı `desired.switch=1` iken `desired.switch=0` yazarsa:
  - Önceki in-flight komut(lar) `cancelled` yapılır (yeni DB fonksiyonu `cancelInFlightForDevice`).
  - `device_desired_state` aynı satırda güncellenir: `desired_value` değişir, `attempt_count=0`,
    `reconcile_status='pending'`, `next_eval_at=NOW()`. Eski satır `superseded` event'i alır.
- **İptal:** `reconcile_status='cancelled'`; in-flight komut iptal; reconciler artık bakmaz.

### 2.5 API değişiklikleri
Dosya: `apps/api/src/main.ts`

Yeni uçlar (irade tabanlı; idempotency-key korunur):
- `PUT /devices/:sn/desired/switch` body `{ "value": 0|1, "setBy"?: string }`
  → `device_desired_state` upsert, supersede mantığı, reconciler tetikleme. **Ana ekran bunu çağırır.**
- `DELETE /devices/:sn/desired/switch` → iptal.
- `GET /devices/:sn/desired` → mevcut irade + reconcile durumu + son komut + presence.

Mevcut `force-switch-0/1` uçları:
- **Geriye dönük uyum:** Bu uçlar artık doğrudan komut yaratmak yerine **iradeyi set eder**
  (içeride `PUT desired/switch`'e yönlendirir). Davranış kullanıcı için aynı görünür ama artık
  kalıcı/dayanıklıdır. `refresh` (okuma) ucu doğrudan komut olarak kalır (irade gerektirmez).
- `getInFlightCommandForDevice` "busy" kontrolü reconciler için içeride yönetilir; kullanıcıya
  409 yerine "irade kaydedildi, reconcile sürüyor" döner.

`GET /devices/:sn/command-diagnostics` çıktısına `desiredState` ve `presence` bölümleri eklenir.

### 2.6 Reported değer çözümü
`resolveReportedValue(sn, 'switch')`:
- Mevcut `resolveSwitchStaFromLatestState` (latest_state `last_summary`/`last_payload` JSON'undan
  `SwitchSta`) yeniden kullanılır. Çok-ürün için bu fonksiyon ileride driver'a taşınır.

---

## 3. Değişecek / Eklenecek Dosyalar (özet)

Faz 0:
- `apps/mqtt-worker/src/main.ts` — QoS1, `clean:false`, sabit clientId, publish damgası.
- `packages/core/src/logger.ts` — yeni pino logger; `config.ts`'e `LOG_LEVEL`.
- `packages/db/migrations/0015_command_indexes_and_publish_attempt.sql` — indeksler + `last_publish_attempt_at`.

Faz 1:
- `packages/db/migrations/0016_desired_state_presence.sql` — `device_desired_state`,
  `device_presence`, policy eklemeleri.
- `packages/db/src/desired-state.ts` — upsert/list/transition fonksiyonları.
- `packages/db/src/presence.ts` — presence upsert/get.
- `packages/db/src/commands.ts` — `cancelInFlightForDevice`, reconcile yardımcı sorgular.
- `apps/mqtt-worker/src/reconciler.ts` — reconciler döngüsü (yeni).
- `apps/mqtt-worker/src/main.ts` — `presence/#` aboneliği + handler; reconciler'ı interval'a ekleme.
- `apps/api/src/main.ts` — desired/presence uçları; force-switch uçlarını iradeye köprüleme.
- `docker-compose.yml` / EMQX config — presence republish rule (rule engine veya bootstrap).

---

## 4. Test Planı
- **Birim:** backoff hesabı, supersede geçişleri, reported==desired karşılaştırma (mevcut
  `command-lifecycle.scenario.test.ts` desenine paralel `reconciler.test.ts`).
- **Senaryo (simülatör):**
  1. Cihaz online, kapat → tek komut, ack, verify, RECONCILED.
  2. Cihaz **ACK vermiyor** → delivery_timeout → reconciler backoff'la tekrar üretir → en sonunda
     telemetriden teyit → RECONCILED (komut pes etse de irade tuttu).
  3. Cihaz **offline** → UNREACHABLE; online event'i gelince anında komut; RECONCILED.
  4. **Supersede:** kapat→aç hızlı ardışık; eski in-flight iptal, yeni irade reconcile.
  5. **Alarm:** uzun süre offline → `unreachable_alarm` event'i, retry sürüyor.
- **Yük (ön):** N=1000 sahte cihaz simülatörle; reconciler turu süresi ve DB sorgu sayısı ölçülür
  (Faz 2 partisyon kararına girdi).

---

## 5. Geriye Dönük Uyum & Geçiş
- Şema eklemeleri additive (mevcut komut akışı bozulmaz).
- Reconciler `reconcile_enabled` ile profil bazında açılır/kapanır → kademeli rollout.
- `force-switch` uçları davranışsal olarak iradeye köprülenir; mevcut entegrasyonlar (ana ekran)
  değişmeden çalışmaya devam eder, dayanıklılık otomatik kazanılır.

---

## 6. Açık Kararlar (kodlamadan önce netleşmeli)
1. Presence kaynağı: **KARAR = EMQX rule-engine republish** (`presence/connected|disconnected` topic'i, worker dinler).
2. `clientid → sn` eşlemesi — **BULGU + KARAR:**
   - Kod/loglar/probe çıktısında MQTT clientid yok; yalnızca uygulama topic'leri var
     (`sys/dev|data/up|indicate/dev` + `productKey` + `sn`). Örnek topic:
     `data/up/NzIxOTYzNTc4MDEwNDMxNDg4/24042809890002` (productKey = base64 görünümlü gateway id, sn = sayaç).
   - Acrel akışı `login → time → topology → update`; **`topology` mesajı gateway/konsantratör
     mimarisini işaret eder** → bir MQTT bağlantısı arkasında birden çok sayaç olabilir.
   - Bu nedenle "clientid = sn" varsayımı **yapılmaz**. Bunun yerine:
     - EMQX rule-engine `message.publish` olayı `clientid + topic` taşır → bu olaydan
       **`mqtt_client_bindings(clientid, product_key, sn, gateway_clientid, last_seen_at)`**
       tablosu trafikten otomatik öğrenilir.
     - Presence olayları clientid seviyesinde gelir; binding tablosuyla **clientid → (gateway →
       arkasındaki sn'ler)** çözülür.
     - Gateway online olsa bile alt-sayaç yanıtsız olabileceği için presence **iki katmanlı**
       değerlendirilir: (a) gateway MQTT bağlantısı, (b) sayaç başına telemetri tazeliği
       (`device_latest_state.last_seen_at`). Reconciler "online" kararını ikisinin birleşiminden verir.
   - **Doğrulama gerekli:** Gerçek bir cihaz bağlandığında EMQX dashboard'undan gerçek clientid
     formatı teyit edilecek (Faz 1 başında).
3. `force-switch` uçları **tamamen** iradeye mi köprülensin yoksa eski davranış flag arkasında mı kalsın? (Faz 1 kararı — kullanıcı onayı bekleniyor.)
4. Unreachable alarmı yalnızca event mi olsun, yoksa Faz 4'e kadar harici bildirim (e-posta/webhook) bekleyecek mi?

> **Faz sırası kararı:** Önce Faz 0 (QoS1 + index + logger) kodlanır; presence/clientid yalnızca
> Faz 1'i ilgilendirir ve Faz 0'ı bloklamaz.

---

## 7. Faz 2 — Yatay Ölçekleme (10.000+ cihaz) — UYGULANDI

Hedef: birden çok worker örneği aynı kuyruğu/iradeyi **mükerrer iş üretmeden** paralel işlesin.

### 7.1 Çoklu-worker eşzamanlılık modeli
| Yol | Mekanizma | Davranış |
| --- | --- | --- |
| Gelen mesajlar (telemetri/ACK) | EMQX **paylaşımlı abonelik** `$share/<grup>/<topic>` | Broker, mesajları worker'lara round-robin dağıtır (yük paylaşımı). |
| Komut yayını (publish) | `claimCommandsForPublish` → `FOR UPDATE SKIP LOCKED` | Her komut satırını yalnızca bir worker kilitler; diğerleri atlar. Paralel kalır. |
| İrade uzlaştırma (reconcile) | `claimDueDesiredStates` → `FOR UPDATE SKIP LOCKED` lease | Her irade satırını yalnızca bir worker kiralar. Paralel kalır. |
| Timeout/expiry süpürmesi | **Postgres advisory lock** (`pg_try_advisory_lock`, key `880421`) | Saf bookkeeping; tek-worker (single-flight) döner. Kazanamayan worker o turu atlar. |

**Karar gerekçesi (timeout süpürmesi):** `processCommandTimeouts` çok sayıda read-then-write
adımı içeren büyük, kanıtlanmış bir fonksiyon. Tüm mutasyonları tek tek atomikleştirmek yüksek
riskli olurdu. Süpürme yalnızca durum geçişi/event yazımı yaptığından (cihaza mükerrer komut
**göndermez** — o zaten atomik claim ile korunur), bütün süpürmeyi advisory lock ile tek-worker
çalıştırmak hem mükerrer event/metrik üretimini önler hem de iç mantığa dokunmaz. Yayın ve
reconcile yolları paralel kaldığı için throughput etkilenmez. Süpürme bir gün darboğaz olursa
sn hash'ine göre parçalanabilir (gelecek iş).

### 7.2 KRİTİK BUG (yük testinde bulundu ve düzeltildi): publish claim head-of-line blocking
- **Belirti:** 300 cihaz + 2 worker yük testinde reconcile **64'te kalıcı olarak takıldı**;
  worker logları sürekli `publish_dispatcher_stuck_signal { eligibleNotClaimedCount: 300, claimResult: empty }`
  bastı. 300 komut `scheduled`'da, sadece 64'ü yayınlanmış.
- **Kök neden:** `claimCommandsForPublish` önce **`LIMIT 20` ile global en eski 20 komutu**
  seçiyor, *sonra* first-per-sn + single-flight filtresini uyguluyordu. En eski 20 satır
  zaten in-flight (verify_pending) olan sn'lere aitse, filtre hepsini eliyor ve claim **0**
  dönüyordu — diğer yüzlerce uygun cihaz açlığa düşüyordu (head-of-line blocking).
- **Düzeltme:** Claim-edilebilirlik filtreleri (first-per-sn sıralaması + single-flight) artık
  `LIMIT`'ten **önce** uygulanıyor; böylece `LIMIT 20 FOR UPDATE SKIP LOCKED` doğrudan gerçekten
  claim-edilebilir satırları seçiyor. (`packages/db/src/commands.ts → claimCommandsForPublish`)
- **Sonuç:** Aynı test **300/300 ≈ 41s**'de uzlaştı, takılma yok.

### 7.3 Teşhis düzeltmesi: yanlış "stuck" alarmı
- Eski `publish_dispatcher_stuck_signal`, sadece `status IN (created,scheduled) AND next_attempt<=now`
  sayıyordu — single-flight ile **meşru** bekleyen komutları (parent'ı in-flight olan refresh
  child'ları) "takılı" sanıyordu (yük testinde fix sonrası 37/38 yanlış alarm).
- Yeni `countClaimableForPublish` claim sorgusunun **birebir filtresini** uygular; alarm yalnızca
  gerçekten claim-edilebilir ama claim-edilmemiş satır varsa basılır. Doğrulama: fix sonrası
  yeniden testte **0 yanlış alarm**.

### 7.4 Yük testi sonucu (yerel, 2 worker, simülatör)
- 300 cihaz, irade 0/1 dönüşümlü, online TTL 600s, reconcile aralığı 2s.
- Düzeltme öncesi: 64'te takıldı (kalıcı).
- Düzeltme sonrası: **300/300 ≈ 41s** (≈28s ısınma + ~13s'de yoğun tamamlanma), 0 hata, 0 stuck.
- 10k çıkarımı: darboğaz publish claim batch (20/pass/worker) ve worker sayısıyla doğrusal ölçeklenir;
  EMQX paylaşımlı abonelik + atomik claim/lease ile worker eklenerek throughput artırılabilir.

### 7.5 Yeni konfigürasyon
- `MQTT_SHARED_GROUP` (varsayılan boş = paylaşımsız; set edilirse `$share/<grup>/...`).
- Çoklu worker için her örneğe **ayrı `MQTT_CLIENT_ID`** verilmeli (persistent session çakışmasını önler).
- `PG_POOL_MAX` (varsayılan 20), `MQTT_INBOUND_CONCURRENCY` (varsayılan 16), `PUBLISH_BATCH_SIZE` (varsayılan 50).

---

## 8. Faz 2b — Uçtan-uca EMQX testi (gerçek broker yolu) — UYGULANDI

Önceki yük testleri simülatör modundaydı: worker komutu broker'a publish etmiyor, ACK/telemetri
döngüsünü process içinde taklit ediyordu (DB hattını kanıtlar ama EMQX mesaj akışını değil). Komutları
**gerçekten broker'dan geçiren** bir test kuruldu:
- `apps/mqtt-worker/load-emulator.mjs`: `indicate/server/#` + `sys/server/#`'e abone olan, komutlara
  ACK (`indicate/dev/...`) ve telemetri (`data/up/...`) ile yanıt veren standalone cihaz-emülatörü
  (simulator.ts mantığının gerçek MQTT karşılığı). **Yalnızca yerel/test broker'ına** yöneltilir.
- Worker'lar `SIMULATOR_MODE=false` ile çalışır; tüm MQTT değişkenleri açıkça yerele sabitlenir
  (`.env`'deki canlı host yanlışlıkla kullanılmasın diye — dotenv mevcut env'i ezmez, yine de açık verilir).

### 8.1 KRİTİK DOĞRULUK BUG'ı (e2e testinde bulundu ve düzeltildi): self-echo ile sahte reconcile
- **Belirti:** 300 cihazlık e2e koşuda reconcile ~210-240'ta platoya takıldı; teşhiste **175 cihaz
  hiçbir komut issue edilmeden (`last_command_id IS NULL`) "reconciled" işaretlenmişti** ve emülatöre
  hiç ulaşmamış cihazların bile `latest_state` satırı vardı.
- **Kök neden:** Worker `sys/#` ve `indicate/#`'e abone oluyordu. Ama worker komutları
  `sys/server/#` / `indicate/server/#`'e publish ediyor — bu topic'ler `sys/#` / `indicate/#`
  filtreleriyle **çakışıyor**. Sonuç: worker (özellikle paylaşımlı abonelikte) **kendi outbound
  komutunu inbound mesaj sanıp** `latest_state`'e yazıyor; reconciler bunu cihazdan gelen rapor gibi
  okuyup komut hiç gönderilmeden "reconciled" diyordu. **Üretimde bu, sayaç gerçekte anahtarlamadan
  komutu "başarılı" sayma riski** — kullanıcının en çok korktuğu sessiz hata.
- **Düzeltme:** Abonelikler **cihaz→sunucu** topic'lerine daraltıldı:
  `["sys/dev/#", "data/up/#", "indicate/dev/#", "presence/#", "meta/#"]`. (`apps/mqtt-worker/src/main.ts → SUB_TOPICS`)
- **Sonuç (düzeltme sonrası, taze EMQX):** **300/300 ≈ 13s**, `reconciled_no_cmd=0`,
  `force_switch=300` (cihaz başına tam 1, aşırı retry yok), emülatör tam 300 cihaz gördü, 0 hata.

### 8.2 Telemetri-tetikli reconcile (e2e testinde bulundu ve eklendi)
- Eskiden `triggerReconcileForSn` yalnızca presence "online" olayında çağrılıyordu; telemetri
  geldiğinde değil. Backoff ~30s olduğundan, cihaz onayladıktan sonra reconciler ancak backoff
  dolunca doğruluyordu → "issue → tam backoff bekle → onayla" merdiveni + gereksiz yeniden-issue.
- **Düzeltme:** `data/up` güncellemesi `reported.SwitchSta` taşıyınca worker hemen
  `triggerReconcileForSn(sn)` çağırır (`next_eval_at=NOW()`); reconciler bir sonraki turda (~2s)
  doğrular. Aktif iradesi olmayan sn için no-op olduğundan ucuzdur. (`main.ts → logNormalizedMessage`)

### 8.3 İnbound darboğaz sıkılaştırması
- `client.on("message")` **sınırsız fire-and-forget** ile işliyordu; burst'te yüzlerce eşzamanlı
  handler küçük (varsayılan 10) PG pool'una hücum ediyordu.
- **Düzeltme:** (a) PG pool `max` yapılandırılabilir (varsayılan 20) + `connectionTimeoutMillis`;
  (b) `MQTT_INBOUND_CONCURRENCY` (varsayılan 16) ile sınırlı bir inbound dispatcher kuyruğu, fazlası
  bellekte sıraya alınır ve `inbound_queue_backpressure` ile gözlemlenir.
