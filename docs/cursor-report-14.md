# Cursor Report 14

## Ne yaptin

- `apps/mqtt-worker` icine local EMQX icin test publisher scripti ekledim.
- Script MQTT broker'a baglanip secilen test mesajini publish ediyor.
- Uc test tipi tanimlandi:
  - login
  - update
  - operate ack
- Bu test tipleri su topic'lere publish eder:
  - `sys/dev/testProduct/testSn001`
  - `data/up/testProduct/testSn001`
  - `indicate/dev/testProduct/testSn001`
- Publish sonrasi kisa bir `publish success` logu ekledim.
- `package.json` scriptleri eklendi:
  - `publish:test:login`
  - `publish:test:update`
  - `publish:test:operate`
- README'ye test publish adimlari ve beklenen davranis eklendi.

## Hangi dosyalari olusturdun/degistirdin

- `apps/mqtt-worker/src/publish-test.ts` (yeni)
- `apps/mqtt-worker/package.json`
- `README.md`
- `docs/cursor-report-14.md`

## Neden boyle yaptin

- Gercek cihaz olmadan worker'in dinledigi topicleri localde hizli test etmek icin tek komutla calisan minimal bir publisher gerekliydi.
- Publisher'i worker app icinde tutarak ayni `.env` config yapisini tekrar kullandim ve ortami tutarli biraktim.
- Topicleri `buildTopic` helper ile ureterek mevcut topic kural setiyle uyumlu tuttum.

## Eksik kalanlar

- Bilerek eklenmedi: DB yazimi.
- Bilerek eklenmedi: command workflow veya publish orchestrasyonu.
- Bilerek eklenmedi: yuksek hacimli load testi / batch publish.

## Sonraki onerilen adim

- Bir sonraki adimda bu publisher icin `--count` ve `--interval` parametreleri eklenerek soak test benzeri daha uzun sureli local testler yapilabilir.
