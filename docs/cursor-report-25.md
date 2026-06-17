# Cursor Report 25

## Ne Degistirdim

Dis fake ack listener yaklasimi yerine worker icinde deterministic bir simulator mode eklendi.

- `SIMULATOR_MODE=true` iken worker, outbound command publish edildiginde artik ayri bir process beklemiyor.
- Worker kendi icinde kisa gecikmelerle:
  - `indicate/dev/{productKey}/{sn}` ack
  - gerekiyorsa `data/up/{productKey}/{sn}` update
  uretiyor.
- Uretilen sahte inbound mesajlar kestirme bir dogrulama fonksiyonuna degil, dogrudan worker'in mevcut normal inbound pipeline'ina giriyor.

## Neden Bu Yaklasim Secildi

Eski modelde:

- API
- worker
- fake ack listener

ayri process'lerde calistigi icin race condition olusuyordu. Ozellikle refresh ACK ile update sirasinda tutarsizliklar cikiyor, testler non-deterministic hale geliyordu.

Tek-proses simulator mode ile:

- sahte cihaz davranisi worker icinde tutuluyor
- zamanlama tek bir event loop uzerinden ilerliyor
- test akisi daha deterministic oluyor
- ayri terminal / ayri test hilesi ihtiyaci kalkiyor

## Hangi Dosyalari Degistirdim

- `packages/core/src/config.ts`
- `apps/mqtt-worker/src/main.ts`
- `apps/mqtt-worker/src/simulator.ts`
- `apps/mqtt-worker/package.json`
- `.env.example`
- `.env.production.example`
- `README.md`
- `docs/cursor-report-25.md`

## Simulator Mode Tasarimi

### Yeni config alani

- `SIMULATOR_MODE`

Bu alan `packages/core/src/config.ts` icinde parse edilip `appConfig.simulatorMode` olarak expose edildi.

### Yeni simulator service

Dosya: `apps/mqtt-worker/src/simulator.ts`

Bu servis:

- publish edilen outbound topic'i kontrol ediyor
- sadece `indicate/server/{productKey}/{sn}` komutlarini ele aliyor
- command payload icindeki `operate.code`, `target`, `expectedSwitch` alanlarini parse ediyor
- `sn` bazinda bellek ici cihaz state'i tutuyor:
  - son switch state
  - son msgid

Deterministic mapping:

- `force_switch_0` -> cihaz state `0`
- `force_switch_1` -> cihaz state `1`
- `refresh` -> mevcut simule state ile update doner

### Inbound pipeline korunmasi

Simulator tarafinda olusturulan ACK ve update mesajlari, worker'in normal inbound isleme hatti olan `logNormalizedMessage(...)` akisi uzerinden isleniyor.

Yani:

- API contract'lari degismedi
- command lifecycle mantigi degismedi
- ayri bir shortcut verify yolu eklenmedi

## Gereksiz Hale Gelen Eski Parcalar

- `apps/mqtt-worker/src/publish-fake-ack.ts` kaldirildi.
- `publish:test:ack-listener` script'i deprecated hale getirildi; artik sadece simulator mode kullanilmasi gerektigini soyler.
- README icindeki ayri fake ack listener adimlari kaldirildi.

## Beklenen Sonuc

`SIMULATOR_MODE=true` iken tek worker prosesi ile:

- `force-switch-0` -> parent `verified_success`, `summary.reported.SwitchSta = 0`
- `force-switch-1` -> parent `verified_success`, `summary.reported.SwitchSta = 1`
- `refresh` -> `verified_success`

Tum bunlar ayri fake listener process'i olmadan calisir.
