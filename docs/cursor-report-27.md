# Cursor Report 27

## Scope

Bu iterasyonda odak telemetry ingest olarak daraltildi. Command ve simulator kodu korunuyor, ancak mevcut dogrulama akisinda kapsam disi birakiliyor.

## Ne Degistirdim

### 1. Worker loglarini telemetry ingest odakli hale getirdim

Dosya: `apps/mqtt-worker/src/main.ts`

Inbound isleme loglari sadeleştirildi ve su adimlar netlestirildi:

- `telemetry inbound`
- `raw saved`
- `device upserted`
- `latest_state updated`

Bu loglarda ozellikle su alanlar gorunur:

- `topic`
- `sn`
- `method`
- `msgid`
- `parseStatus`

Boylece gercek cihazdan gelen login/update akisi, command testlerinden bagimsiz bicimde izlenebilir hale geldi.

### 2. Summary uretimindeki telemetry alanlari netlestirildi

Mevcut normalize akisi dogrulandi:

- `state`
- `Ua`
- `Ia`
- `P`
- `PF`
- `EPI`
- `Balance`
- `SwitchSta`

Bu alanlar `update` mesajlarinda `reported` icinden alinip `latest_state.last_summary` ve `GET /devices/:sn/summary` uzerinden gorulebilir durumda tutuluyor.

### 3. README telemetry-only validation moduna gore guncellendi

Dosya: `README.md`

Yeni bolum eklendi:

- `Telemetry-only validation`

Bu bolumde:

- gercek cihaz geldiginde hangi topiclerin dinlendigi
- worker loglarinda hangi satirlarin izlenecegi
- hangi endpointlerle kontrol yapilacagi
- command/simulator akisinin `not in current validation scope` oldugu

acikca belirtildi.

## Hangi Dosyalari Degistirdim

- `apps/mqtt-worker/src/main.ts`
- `README.md`
- `docs/cursor-report-27.md`

## Neden Bu Yaklasim

Bu asamada ihtiyac, command test zincirinden bagimsiz olarak gercek cihaz telemetry ingest akisinin net ve gozlemlenebilir olmasiydi.

Bu nedenle:

- veri alma loglari sadeleştirildi
- ham veri, cihaz kaydi ve latest state guncellemesi birbirinden ayri ve gorunur hale getirildi
- API yuzeyi telemetry dogrulama icin odaga alindi

## Beklenen Sonuc

Gercek cihazdan login/update geldiginde:

- ham veri `GET /messages/raw` ile gorulebilir
- cihaz kaydi `GET /devices` ve `GET /devices/:sn` ile gorulebilir
- normalize son durum `GET /devices/:sn/latest-state` ve `GET /devices/:sn/summary` ile izlenebilir

Veri alma akisi boylece command testlerinden bagimsiz, net bir telemetry-only dogrulama moduna tasinmis olur.
