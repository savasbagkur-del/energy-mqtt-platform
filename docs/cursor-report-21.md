# Cursor Report 21

## Ne yaptin

- Force-switch command zincirini parent-child dogrulama odakli tamamladim.
- `force-switch-0/1` endpointlerinden olusan switch command:
  - `created` -> worker publish -> `published`
  - fake ack ile `ack_received`
  - ack sonrasi otomatik child refresh command olusur (`parent_command_id` set)
- Child refresh command lifecycle:
  - `created`
  - `published`
  - `ack_received`
  - `verified_success`
- Parent switch verify kurali:
  - child refresh `verified_success` olduktan sonra
  - `latest_state.last_summary.reported.SwitchSta` okunur
  - merkezi mapping ile karsilastirilir:
    - `force_switch_0 => 0`
    - `force_switch_1 => 1`
  - eslesirse parent `verified_success`
  - eslesmezse parent `verification_failed`
- `command_events` gecisleri parent ve child icin yazilir.
- `GET /commands/:id` zaten parent `events` + `children` dondugu icin parent-child iliskisi net gorunur halde tutuldu.
- Fake test akisi genisletildi:
  - `publish-fake-ack` artik switch komutundan hedef `SwitchSta` degerini hafizada tutuyor.
  - refresh komutu geldiginde ack yaninda otomatik `data/up/...` update mesaji da gonderiyor.
- Worker loglari guclendirildi:
  - `switch published`
  - `switch ack received`
  - `child refresh created`
  - `child refresh verified`
  - `parent switch verified_success` / `parent switch verification_failed`
- README switch command test akisi ve SwitchSta dogrulama mantigi ile guncellendi.

## Hangi dosyalari degistirdin

- `apps/mqtt-worker/src/main.ts`
- `apps/mqtt-worker/src/publish-fake-ack.ts`
- `packages/db/src/commands.ts`
- `packages/db/src/types.ts`
- `README.md`
- `docs/cursor-report-21.md`

## Neden boyle yaptin

- Switch komutunun yalnizca ack ile tamamlanmasi operasyonel olarak yeterli degildi; gercek etkiyi (`SwitchSta`) gormek gerekiyordu.
- Bu nedenle parent switch sonucunu child refresh ile dogrulanan state'e baglayarak daha gercekci ve production'a yakin bir lifecycle olusturdum.
- Test ortami icin fake ack scriptinin update üretmesiyle gercek cihaz olmadan zincir tam dogrulanabilir hale geldi.

## Eksik kalanlar

- Retry/timeout yok (istenmedigi icin).
- Queue/rule engine yok.
- Parent verify fallback olarak sadece latest state summary kullaniyor; ileri seviye edge-case kurallari yok.

## Sonraki onerilen adim

- Command lifecycle icin timeout policy eklenmeli (`ack_timeout`, `verify_timeout`) ve bu gecisler de `command_events` uzerinden izlenmeli.
