# Cursor Report 28

## Amac

Gercek sayaç telemetry ingest icin protocol handshake'i worker tarafinda tamamlamak:

- `login` alinca login response
- `time` alinca time response
- `topology` alinca topology response

Boylece cihazin `data/up/...` update asamasina gecmesi saglansin.

## Yapilan Degisiklikler

Dosya: `apps/mqtt-worker/src/main.ts`

1. `sys/dev` handshake mesaji yakalama eklendi:
   - Yalnizca `topic.channel === "sys"` ve `segments[1] === "dev"` icin calisir.
2. Ortak response publisher eklendi:
   - `publishProtocolResponse(...)`
   - hedef topic: `sys/server/{productKey}/{sn}`
3. Login response:
   - `method=login`
   - `same msgid`
   - `same sn`
   - `res=1`
   - `current timestamp`
4. Time response:
   - `method=time`
   - `same msgid`
   - `same sn`
   - `timezone`
   - `devicesend`
   - `serverreceive`
   - `serversend`
   - `timestamp`
   - `timezoneMin`
5. Topology response:
   - `method=topology`
   - `same msgid`
   - `same sn`
   - `res=1`
   - `current timestamp`
6. Acik loglar eklendi:
   - `login response published`
   - `time response published`
   - `topology response published`

Bu ekleme command/force/simulator akisina dokunmadan yapildi.

## Dokumantasyon Guncellemesi

Dosya: `README.md`

- `Telemetry-only validation` bolumune Acrel handshake sirasinin worker tarafinda nasil tamamlandigi eklendi.

## Degisen Dosyalar

- `apps/mqtt-worker/src/main.ts`
- `README.md`
- `docs/cursor-report-28.md`

## Beklenen Sonuc

- `sys/dev` login/time/topology akisi worker tarafinda cevaplanir.
- Cihaz handshake sonrasi `data/up/{productKey}/{sn}` ile `method=update` gondermeye baslar.
- Worker update telemetry ingest akisini normal sekilde isler.

## Ek Sertlestirme (Gercek Cihaz Uyumu)

Bazi cihazlar `msgid` yerine `msgId` / `MsgID` kullanabildigi icin:

- `packages/mqtt/src/normalize.ts` icinde protocol msgid cozumu genisletildi.
- `maybeHandleProtocolHandshake` icinde msgid icin payload fallback ve `method` icin case-insensitive eslestirme eklendi.
- `time` cevabinda `devicesend` icin `deviceSend` / `DeviceSend` alternatifleri desteklenir.

Eksik `msgid` ile handshake cevabi hic publish edilmedigi icin bu degisiklikler gercek sayac senaryosu icin kritiktir.
