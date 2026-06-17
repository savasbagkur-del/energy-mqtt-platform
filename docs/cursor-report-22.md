# Cursor Report 22

## Scope

Fake ACK / fake refresh simulasyonunda switch hedef state'inin tutarsiz uretilmesi duzeltildi. Verification motoru ve parent/child lifecycle mantigi degistirilmedi.

## Sorun Neydi

- `force-switch-0` ve `force-switch-1` testlerinde fake akista uretilen refresh update payload'i bazen beklenen hedef switch degerini tasimiyordu.
- Fake dinleyici tarafinda `reported.SwitchSta` degeri son gorulen state veya varsayilan degerden gelebiliyordu; bu da test sonucunu non-deterministic yapabiliyordu.

## Nasil Duzeltildi

1. Fake sim tarafina tek merkezli helper eklendi:
   - `toSwitchState(...)`
   - `resolveTargetSwitchState(...)`
2. Hedef state belirleme kurallari netlestirildi:
   - `FORCE_SWITCH` komutunda `operate.target` degeri parse edilip state map'e yaziliyor.
   - `REFRESH` komutunda varsa `operate.expectedSwitch` kullaniliyor ve state map guncelleniyor.
   - Yukaridaki kaynaklar yoksa sadece son state fallback olarak kullaniliyor.
3. Refresh update payload'i deterministic hale getirildi:
   - `data/up/...` mesajinda `reported.SwitchSta` her zaman `resolveTargetSwitchState(...)` sonucundan uretiliyor.
4. Worker outbound refresh payload'ina fake sim icin acik hedef hint'i eklendi:
   - `operate.expectedSwitch`
   - Bu deger child refresh komutu olusturulurken parent switch hedefinden geliyor.
5. README'ye kisa test notu eklendi:
   - Switch testinde fake update hedef switch degerini birebir yansitmalidir.

## Degisen Dosyalar

- `apps/mqtt-worker/src/publish-fake-ack.ts`
- `apps/mqtt-worker/src/main.ts`
- `README.md`
- `docs/cursor-report-22.md`

## Sonuc

Beklenen test davranisi:

- `force-switch-0` sonrasi `summary.reported.SwitchSta = 0`
- `force-switch-1` sonrasi `summary.reported.SwitchSta = 1`

Boylece parent komutun `verified_success` / `verification_failed` karari, fake update state'i tarafindan dogru ve deterministic sekilde tetiklenir.
