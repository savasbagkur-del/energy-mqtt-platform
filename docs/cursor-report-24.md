# Cursor Report 24

## Problem

Son e2e akista iki ariza goruldu:

1. `force-switch-0`
   - `summary.reported.SwitchSta = 0` gelmesine ragmen child refresh `ack_received` durumunda kaldi.
   - Bu, `update` mesaji gelmis olsa bile child verify transition'in her zaman tetiklenmedigini gosteriyordu.

2. `force-switch-1`
   - Parent ve child `ack_received` durumunda kaldi.
   - `summary.last_method = operate` ve `reported.SwitchSta` yoktu.
   - Bu da fake refresh -> update zincirinin deterministik tamamlanmadigini gosteriyordu.

## Root Cause

- Worker tarafinda `update` verify akisi yalnizca update anindaki state'e bagliydi. `update`, refresh ACK'den once islenirse child command henuz `ack_received` olmadigi icin verify kaciriliyordu.
- Fake listener tarafinda refresh ACK ile update neredeyse ayni anda publish ediliyordu. Bu, yukaridaki race condition'i gercekte tetikliyordu.

## Fixes

### 1. Worker verify zinciri saglamlastirildi

Dosya: `apps/mqtt-worker/src/main.ts`

- `update received for verification` logu eklendi.
- Refresh ACK alindiginda worker artik yalnizca status'u `ack_received` yapmiyor; ayni anda mevcut `latest_state` uzerinden verify tekrar deniyor:
  - `await tryVerifyRefreshCommandsFromLatestState(resolved.sn)`
- Boylece `update` daha once gelmisse child refresh verify kacmiyor.

### 2. Child refresh verify kosulu guclendirildi

- Verify icin zorunlu kosullar korunuyor:
  - `latest_state.last_method === "update"`
  - `latest_state.last_summary.reported` mevcut
- Buna ek olarak, child refresh icinde `expectedSwitch` varsa:
  - `reported.SwitchSta === expectedSwitch` olmadan `verified_success` verilmiyor.
- Basarili durumda log:
  - `refresh child verified from update`

### 3. Parent switch verify sadece dogru child verify sonrasinda calisiyor

- Child refresh `verified_success` olduktan sonra parent verify tetikleniyor.
- Parent mevcut motor ile:
  - `latest_state.summary.reported.SwitchSta`
  - `expectedSwitch`
  karsilastirarak karar veriyor.
- Loglar korunup netlestirildi:
  - `parent switch verified_success`
  - `parent switch verification_failed`

### 4. Fake refresh/update akisi deterministic hale getirildi

Dosya: `apps/mqtt-worker/src/publish-fake-ack.ts`

- Refresh ACK sonrasinda update publish dogrudan ayni callback icinde degil, kisa gecikmeyle yapiliyor:
  - `UPDATE_DELAY_MS = 250`
- Bu sayede child refresh once `ack_received` olur, sonra `data/up/{productKey}/{sn}` update gelir.
- Update publish merkezi helper'a tasindi:
  - `publishRefreshUpdate(...)`
- Ek loglar eklendi:
  - `outbound command received`
  - `scheduling refresh update`
  - `refresh update published`

## Changed Files

- `apps/mqtt-worker/src/main.ts`
- `apps/mqtt-worker/src/publish-fake-ack.ts`
- `docs/cursor-report-24.md`

## Validation

- `pnpm --filter db build`
- `pnpm --filter mqtt-worker typecheck`
- `pnpm --filter api typecheck`

## Expected Result

- `force-switch-0` -> parent `verified_success`, `summary.reported.SwitchSta = 0`
- `force-switch-1` -> parent `verified_success`, `summary.reported.SwitchSta = 1`
- Child refresh sadece `update` uzerinden `verified_success` olur
