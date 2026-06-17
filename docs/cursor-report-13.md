# Cursor Report 13

## Ne yaptin

- `apps/mqtt-worker` subscribe akisini teshis edip yeniden duzenledim.
- Subscribe listesi worker tarafinda sabit ve acik hale getirildi:
  - `sys/dev/+/+`
  - `data/up/+/+`
  - `indicate/dev/+/+`
- Baglanti sonrasi subscribe cagrisi ayrik helper ile netlestirildi.
- `subscriptions ready` logu `requested` ve `granted` alanlariyla guclendirildi.
- `granted` broker tarafindan bos donerse fallback olarak istenen topic listesi loglanir hale getirildi.
- MQTT event loglari guclendirildi: `connect`, `reconnect`, `close`, `offline`, `error`, `end` ve ek olarak `disconnect`.
- Worker icinde helper ayrimi yapildi:
  - subscribe olusturma/cagirma
  - granted liste formatlama
  - mesaj normalize/loglama
- README'ye troubleshooting notu eklendi (EMQX unhealthy olsa da 1883 test edilebilir).

## Hangi dosyalari degistirdin

- `apps/mqtt-worker/src/main.ts`
- `README.md`
- `docs/cursor-report-13.md`

## Sorunun kok nedeni neydi

- Broker baglantisi acilsa bile bazi reconnect dongulerinde SUBACK cevabi `granted` listesi bos gelebiliyordu.
- Bu nedenle logda `subscriptions ready { subscriptions: [] }` gorunuyor ve subscribe akisi belirsizlesiyordu.
- Ek olarak EMQX tarafindaki unstable/health durumu reconnect dongusunu tetikliyordu.

## Nasil duzelttin

- Subscribe akisini sabit topic listesi + acik helper yapisina tasidim.
- Callback'te `requested` ve `granted` birlikte loglanarak subscribe sonucu gozlemlenebilir hale getirildi.
- `granted` bos dondugunde warning + fallback log eklendi:
  - `requested qos 0, suback missing`
- Boylece baglanti sonrasi hangi topic'lere subscribe edilmeye calisildigi ve broker cevabinin durumu net gorunuyor.

## Eksik kalanlar

- Bilerek eklenmedi: DB yazimi.
- Bilerek eklenmedi: command publish akisi.
- Broker neden ara ara SUBACK entries donmedi konusu uygulama disi (EMQX/runtime ag sagligi) olabilir; kod tarafinda sadece gozlemlenebilirlik iyilestirildi.

## Sonraki onerilen adim

- EMQX loglari ile worker loglarini birlikte izleyip reconnect/disconnect zamaninda broker reason code analizi yapin; gerekirse keepalive/reconnect ayarlari ortam bazli tune edilsin.
