# Cursor Report 15

## Ne yaptin

- `packages/db` icinde migration yapisi kurup `raw_mqtt_messages` tablosunu netlestirdim.
- `apps/mqtt-worker` tarafina gercek Postgres baglantisi ekledim (env tabanli).
- Worker gelen her MQTT mesaji icin `raw_mqtt_messages` tablosuna kayit yazar hale getirildi.
- Parse basarisina gore `parse_status` alanini `parsed` / `parse_failed` olarak yazdim.
- Parse hatasi olsa da processi dusurmeden kayit alma akisina devam ettirdim.
- `apps/api` icine `GET /messages/raw` endpointi ekleyip son 20 kaydi dondurur hale getirdim.
- README'ye migration, worker->DB akisi ve raw endpoint kullanim notlarini ekledim.

## Hangi dosyalari olusturdun/degistirdin

### Olusturulanlar

- `packages/db/migrations/0001_create_raw_mqtt_messages.sql`
- `packages/db/src/client.ts`
- `packages/db/src/raw-mqtt-messages.ts`
- `packages/db/src/types.ts`
- `packages/db/src/migrate.ts`
- `docs/cursor-report-15.md`

### Degistirilenler

- `packages/db/package.json`
- `packages/db/tsconfig.json`
- `packages/db/src/index.ts`
- `apps/mqtt-worker/package.json`
- `apps/mqtt-worker/src/main.ts`
- `apps/mqtt-worker/src/publish-test.ts`
- `apps/api/package.json`
- `apps/api/src/main.ts`
- `README.md`

## Neden boyle yaptin

- ORM eklemeden, production'a yakin ama sade bir yaklasimla `pg` uzerinden ham inbound capture akisinin hizla calismasi hedeflendi.
- Migration'lari SQL dosyasi + basit runner ile tutarak surdurulebilir bir schema evrimi saglandi.
- Worker tarafinda parse hatalarini kayda alan ama islemi durdurmayan yapiyla veri kaybi azaltildi.
- API endpointi ile kayitlari dogrudan gormek kolaylastirildi.

## Eksik kalanlar

- Bilerek eklenmedi: latest state guncellemesi.
- Bilerek eklenmedi: devices/commands workflow.
- Bilerek eklenmedi: ileri seviye retry/backoff ve DLQ benzeri hata yonetimi.

## Sonraki onerilen adim

- Bir sonraki adimda `raw_mqtt_messages` uzerinden parser pipeline kurularak normalize edilmis state tablolarina asenkron isleme akisi eklenebilir.
