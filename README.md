# Communication MVP Monorepo

MQTT sayac haberlesmesini test etmeye yonelik backend baslangic iskeleti.
Bu asamada sadece monorepo yapisi ve minimal calisir bootstrap kodu bulunur.

## Klasorler

- `apps/api`
- `apps/mqtt-worker`
- `packages/core`
- `packages/db`
- `packages/mqtt`
- `packages/contracts`
- `infra/docker`
- `docs`

## Teknoloji Secimleri

- Node.js 20
- TypeScript (`strict`)
- pnpm workspace
- Docker
- PostgreSQL
- EMQX

## Kurulum

1. `pnpm install`
2. `.env.example` dosyasini `.env` olarak kopyala
3. `api` ve `mqtt-worker` uygulamalari root `.env` dosyasini otomatik olarak okur.

## Workspace Komutlari

- `pnpm dev` -> `api` ve `mqtt-worker` uygulamalarini paralel baslatir
- `pnpm build` -> tum workspace paketlerini TypeScript ile derler
- `pnpm typecheck` -> tum workspace icin strict type kontrolu yapar
- `pnpm lint` -> su an typecheck tabanli minimum lint gorevi calistirir
- `pnpm clean` -> workspace `dist` ciktilarini temizler

## Docker Servisleri

1. `docker compose up -d`
2. Local servisleri baslatmak icin bu komutu proje kok dizininde calistir.
3. PostgreSQL: `localhost:5433` (local host port)
4. EMQX MQTT: `localhost:1883`
5. EMQX WebSocket: `localhost:8083`
6. EMQX Secure WebSocket: `localhost:8084`
7. EMQX Dashboard: `http://localhost:18083`

## DB Migration

- Tum migrationlari uygulamak icin:
  - `pnpm --filter @communication/db migrate`
- Olusturulan tablolar:
  - `raw_mqtt_messages`: her gelen MQTT mesajinin ham kaydi (audit / debug)
  - `devices`: cihaz gorunurlugu (`sn`, `product_key`, `last_seen_at`, metadata)
  - `latest_state`: her cihaz icin son bilinen mesaj ozeti; ayrica Acrel-benzeri normalize `last_summary` (JSON) (timestamp kurali ile guncellenir)

**Raw vs devices / latest_state:** `raw_mqtt_messages` immutable ham logdur. Worker ayrica her inbound mesajda `devices` tablosunu upsert eder ve mesaj zamani daha yeniyse `latest_state` guncellenir.

## Uygulamalari Calistirma

- API (watch mode): `pnpm --filter api dev`
- Worker (watch mode): `pnpm --filter mqtt-worker dev`

API calistiginda `/health` ve config tabanli readiness icin `/ready` endpointleri aktif olur.
`/ready`, root `.env` icinden yuklenen PostgreSQL ve MQTT konfigurasyon alanlarinin varligini raporlar.

## MQTT Worker (Local EMQX)

- EMQX'i lokalde baslat: `docker compose up -d`
- Worker'i calistir: `pnpm --filter mqtt-worker dev`
- Tek proses simulator mode icin `.env` icinde `SIMULATOR_MODE=true` ayarla.
- Worker her gelen MQTT mesaji icin `raw_mqtt_messages` tablosuna bir kayit yazar; `sn` ve `product_key` cikarilabiliyorsa `devices` ve `latest_state` guncellenir.
- Worker bu topic pattern'lerini dinler:
  - `sys/dev/+/+`
  - `data/up/+/+`
  - `indicate/dev/+/+`
- Beklenen loglar:
  - baglanti olaylari: `connect`, `reconnect`, `offline`, `close`, `error`, `end`
  - telemetry ingest loglari: `telemetry inbound`, `raw saved`, `device upserted`, `latest_state updated`
  - telemetry ozeti: `topic`, `sn`, `method`, `msgid`, `parseStatus`
  - parse edilemeyen payload'lar icin `payload parse warning` (process calismaya devam eder)
  - `subscriptions ready` logunda `requested` ve `granted` alanlari

## MQTT Test Publish

- Test publisher mesajlari **Acrel MQTT protokolune yaklasan** ornek fixture'lardir (tam production parser degildir).
- Worker'i ayri terminalde calistir: `pnpm --filter mqtt-worker dev`
- Asagidaki tek komutlarla test mesaji publish edebilirsin:
  - Login: `pnpm --filter mqtt-worker publish:test:login`
  - Update: `pnpm --filter mqtt-worker publish:test:update`
  - Operate Ack: `pnpm --filter mqtt-worker publish:test:operate`
- Publisher hedef topicleri:
  - `sys/dev/testProduct/testSn001`
  - `data/up/testProduct/testSn001`
  - `indicate/dev/testProduct/testSn001`
- Basarili publish sonrasi terminalde `publish success` logu gorulur, worker tarafinda da mesaj loglari akar.
- Worker acikken test publish komutu calisirsa gelen mesajlar Postgres'e kaydolur.

## Raw Message API

- Son 20 ham MQTT kaydini gormek icin:
  - `GET /messages/raw`
- Ornek:
  - `http://localhost:3000/messages/raw` (API port `.env` icindeki `API_PORT`)

## Devices API

- Tum cihazlar: `GET /devices`
- Tek cihaz: `GET /devices/:sn` (ornek: `/devices/testSn001`)
- Son durum: `GET /devices/:sn/latest-state`
- Normalize ozet (Acrel-benzeri `last_summary`): `GET /devices/:sn/summary`

`summary.reported` icinde telemetry odakli normalize alanlar bulunur:

- `state`
- `Ua`
- `Ia`
- `P`
- `PF`
- `EPI`
- `Balance`
- `SwitchSta`

## Telemetry-only Validation

Bu asamada gecerli dogrulama kapsami yalnizca telemetry ingest'tir. Gercek cihazdan gelen login ve update mesajlari uzerinden veri alma akisi dogrulanir.

Dinlenen topicler:

- `sys/dev/+/+`
- `data/up/+/+`
- `indicate/dev/+/+`

Gercek cihaz protocol handshake (Acrel akisi):

1. Cihaz `sys/dev/{productKey}/{sn}` ile `method=login` gonderir.
2. Worker `sys/server/{productKey}/{sn}` topicine `method=login` response publish eder (`res=1`).
3. Cihaz `method=time` gonderdiginde worker `method=time` response publish eder.
4. Cihaz `method=topology` gonderdiginde worker `method=topology` response publish eder (`res=1`).
5. Bu adimlar tamamlandiktan sonra cihaz `data/up/{productKey}/{sn}` uzerinden `method=update` gondermeye baslar.

Gercek cihaz geldiginde kontrol sirasi:

1. Worker loglarinda inbound akisi izle:
   - `telemetry inbound`
   - `raw saved`
   - `device upserted`
   - `latest_state updated`
2. Ham mesaji kontrol et:
   - `GET /messages/raw`
3. Cihazin envanter kaydini kontrol et:
   - `GET /devices`
   - `GET /devices/:sn`
4. Son normalize durumu kontrol et:
   - `GET /devices/:sn/latest-state`
   - `GET /devices/:sn/summary`

Beklenen sonuc:

- Login geldiyse cihaz metadata bilgileri `devices` tablosuna yansir.
- Update geldiyse `latest_state` ve `summary.reported` alanlari guncellenir.
- Ham payload'lar her durumda `messages/raw` icinde gorunur.

## Commands API (Local Lifecycle)

Not: Command ve simulator kodu projede tutuluyor ancak current validation scope icinde degildir. Bu asamada telemetry ingest dogrulamasi esas alinmalidir.

- Refresh komutu: `POST /devices/:sn/commands/refresh`
- Switch OFF komutu: `POST /devices/:sn/commands/force-switch-0`
- Switch ON komutu: `POST /devices/:sn/commands/force-switch-1`
- Komut detay + eventler: `GET /commands/:id`

Lifecycle:

1. API komut kaydi olusturur (`status=created`) ve `command_events` icine `created` yazar.
2. Worker `indicate/server/{productKey}/{sn}` topicine publish eder -> `published`.
3. `indicate/dev/{productKey}/{sn}` ack gelirse -> `ack_received`.
4. `refresh` komutu yalnizca `data/up/{productKey}/{sn}` update ve `summary.reported` geldikten sonra `verified_success` olur.
5. Switch komutundan sonra worker otomatik child refresh komutu olusturur (`parent_command_id` set).
6. Child refresh `created -> published -> ack_received -> verified_success` zincirini tamamlar.
7. Ardindan parent switch command icin `SwitchSta` kontrol edilir:
   - `force-switch-0` => beklenen `SwitchSta=0`
   - `force-switch-1` => beklenen `SwitchSta=1`
   - eslesirse `verified_success`, eslesmezse `verification_failed`.

## Command Test Akisi

1. `.env` icinde `SIMULATOR_MODE=true` ayarla.
2. Worker: `pnpm --filter mqtt-worker dev`
3. API uzerinden komut olustur:
   - `POST /devices/testSn001/commands/refresh`
   - `POST /devices/testSn001/commands/force-switch-0`
   - `POST /devices/testSn001/commands/force-switch-1`
4. Donen `id` ile komut yasam dongusu:
   - `GET /commands/{id}`
   - parent command cevabinda `children` alaninda child refresh commandlar gorunur.

Not:

- Ayrica `fake ack listener` calistirmaya gerek yoktur.
- `SIMULATOR_MODE=true` iken worker, outbound command publish edildiginde kendi icinde deterministic olarak:
  - `indicate/dev/{productKey}/{sn}` ack
  - gerekiyorsa `data/up/{productKey}/{sn}` update
  uretir ve bunlari normal inbound pipeline'dan isler.
- Simule cihaz state'i bellek icinde `sn` bazinda tutulur.

Beklenen loglar:

- `switch published`
- `switch ack received`
- `child refresh created`
- `update received for verification`
- `refresh child verified from update`
- `parent switch verified_success` (veya `parent switch verification_failed`)

Simulator mode'da refresh update payload'i `reported.SwitchSta` alanini deterministic olarak yansitir:

- `force-switch-0` -> `SwitchSta = 0`
- `force-switch-1` -> `SwitchSta = 1`

## MQTT Troubleshooting

- EMQX container `unhealthy` gorunse bile `1883` listener aciksa worker baglanti ve subscribe testi yapilabilir.
- `subscriptions ready` icinde `granted` bos gelirse worker `requested` listesini de loglar; bu sayede broker/suback davranisi kolayca teshis edilir.

## Independent Deployment v1

Ilk production deployment modeli:

- Tek EC2 uzerinde Docker Compose
- RDS PostgreSQL ayri servis
- EMQX + API + mqtt-worker EC2 icinde

Kullanilacak dosyalar:

- `docker-compose.prod.yml`
- `.env.production.example`
- `deploy/bootstrap.sh`
- `deploy/README-deploy.md`

Hizli adim:

1. `.env.production.example` -> `.env.production`
2. `./deploy/bootstrap.sh`

Not: Production oncesi EMQX icin edition/lisans karari (Community/Enterprise) netlestirilmelidir.
