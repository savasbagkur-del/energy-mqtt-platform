# Cursor Report 29

## Problem

Gercek cihazdan tekrarlayan `login` (`msgid: 0`) goruluyordu; `data/up` `update` gelmiyordu. Acrel akisi `login -> time -> topology -> update` gerektirdigi icin handshake cevaplarinin kesin formatta publish edilmesi ve loglanmasi gerekiyordu.

## Root Cause (msgid = 0)

Onceki `resolveHandshakeMsgid` mantiginda `msgid` icin `if (v)` / `if (normalized.msgid)` benzeri kontroller **sayisal 0** veya **"0"** edge case'lerinde handshake'i yanlislikla atlatabilirdi. Ayrica login cevabinda `timestamp` ISO string kullaniliyordu; cihaz dokumanina uygun olarak **Unix saniye (sayi)** bekleniyordu.

## Fixes

Dosya: `apps/mqtt-worker/src/main.ts`

1. **`getOutboundMsgid`**
   - Payload icindeki `msgid` alani **dogrudan** okunur; `0` dahil sayisal degerler korunur.
   - Eksik `msgid` ile handshake atlanmaz / yanlis atlama yapilmaz: `hasOutboundMsgid` kullanilir.

2. **Outbound topic (sabit)**

   `sys/server/{productKey}/{sn}`

   (`buildTopic("sys", "server", productKey, deviceSn)`)

3. **Login response JSON (sabit sira ve alanlar)**

   ```json
   {
     "msgid": <same as device, e.g. 0>,
     "method": "login",
     "sn": "<same sn>",
     "res": 1,
     "timestamp": <current unix seconds, number>
   }
   ```

4. **Publish loglari**

   - Publish oncesi: `protocol response publishing` + `outboundTopic` + `payloadJson` (string)
   - Login sonrasi: `login response published`
   - Time sonrasi: `time response published`
   - Topology sonrasi: `topology response published`

5. **Inbound loglari**

   - `login request received`
   - `time request received`
   - `topology request received`

6. **Time / topology response**

   - `timestamp`, `serverreceive`, `serversend` alanlari Unix saniye (sayi) olacak sekilde guncellendi (login ile tutarli).

## Onceki Ilgili Duzenlemeler (hatirlatma)

- `packages/mqtt/src/topic.ts`: topic kanal segmenti case-insensitive (`Sys/...` vb.).

## Beklenen Sonuc

- Login cevabi broker uzerinde `sys/server/...` altinda publish edilir.
- Loglarda `protocol response publishing` ve `login response published` acikca gorunur.
- Cihaz `time` / `topology` asamalarina gecebilir; ardindan `data/up/...` `method=update` ile telemetry baslar.
