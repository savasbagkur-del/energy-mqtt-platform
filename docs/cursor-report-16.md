# Cursor Report 16

## Ne yaptin

- `packages/db` altinda `devices` ve `latest_state` tablolari icin migration (`0002`) ekledim.
- Inbound mesajdan `sn` ve `product_key` (topic + payload) ile cihaz cozumlemesi ve metadata (`devname`, `softcode`, `softversion`, `network`) cikarma yardimcilarini ekledim.
- Worker her basarili raw insert sonrasi `devices` upsert ve kosullu `latest_state` guncellemesi calistiriyor.
- Timestamp kurali: payload `timestamp` ISO parse edilebiliyorsa o kullanilir; degilse `received_at` fallback; `latest_state` sadece yeni efektif zaman oncekinden buyukse guncellenir (`ON CONFLICT ... WHERE`).
- API: `GET /devices`, `GET /devices/:sn`, `GET /devices/:sn/latest-state` eklendi.
- README: raw vs devices/latest_state farki ve yeni endpointler aciklandi.

## Hangi dosyalari olusturdun/degistirdin

### Yeni

- `packages/db/migrations/0002_create_devices_and_latest_state.sql`
- `packages/db/src/payload-fields.ts`
- `packages/db/src/timestamp.ts`
- `packages/db/src/devices.ts`
- `packages/db/src/latest-state.ts`
- `packages/db/src/inbound-device-state.ts`
- `docs/cursor-report-16.md`

### Degistirilen

- `packages/db/src/types.ts`
- `packages/db/src/index.ts`
- `apps/mqtt-worker/src/main.ts`
- `apps/api/src/main.ts`
- `README.md`

## Neden boyle yaptin

- ORM kullanmadan `pg` + SQL ile upsert ve kosullu guncelleme net kontrol altinda.
- Ham kayit (`raw_mqtt_messages`) ile turetilmis durum (`devices`, `latest_state`) ayrildi; audit ve operasyonel okuma ayri kaldi.
- Metadata alanlari yalnizca payload’da geldiginde doldurulacak sekilde `COALESCE` ile mevcut degerler korunuyor.

## Eksik kalanlar

- Command workflow, rule engine, aggregate raporlar bilerek yok.
- Cihaz silme / tam reconciliation job yok.

## Sonraki onerilen adim

- `latest_state` ve `raw_mqtt_messages` uzerinden idempotent is kurallari (normalize pipeline) ve ops UI icin filtreli listeler.
