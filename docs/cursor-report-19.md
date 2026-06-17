# Cursor Report 19

## Ne yaptin

- `commands` ve `command_events` icin tam lifecycle tabanini ekledim.
- API'ye su endpointleri ekledim:
  - `POST /devices/:sn/commands/refresh`
  - `POST /devices/:sn/commands/force-switch-0`
  - `POST /devices/:sn/commands/force-switch-1`
  - `GET /commands/:id`
- API command olustururken:
  - `commands` tablosuna `status=created` kaydi aciyor
  - `command_events` tablosuna `created` eventi yaziyor
- Worker tarafina outbound publish loop ekledim:
  - `created` komutlari claim eder
  - `indicate/server/{productKey}/{sn}` topicine publish eder
  - basarili publish -> `published` + event
  - publish hatasi -> `publish_failed` + event + error log
- `indicate/dev/{productKey}/{sn}` ack geldiginde:
  - `msgid + sn + method` ile command eslestirme
  - `ack_received` + event
- Switch komutundan sonra otomatik refresh command uretimi eklendi.
- Update mesaji geldikten sonra refresh verify akisi eklendi:
  - expected switch degeri ile `reported.SwitchSta` karsilastirma
  - refresh command `verified_success/verified_failed`
  - parent switch command da `verified_success/verified_failed`
- Test kolayligi icin fake ack listener scripti eklendi:
  - outbound `indicate/server/+/+` dinler
  - otomatik `indicate/dev/+/+` ack publish eder
- README komut lifecycle ve test adimlariyla guncellendi.

## Hangi dosyalari olusturdun/degistirdin

### Yeni dosyalar

- `packages/db/migrations/0004_create_commands_and_events.sql`
- `packages/db/src/commands.ts`
- `apps/mqtt-worker/src/publish-fake-ack.ts`
- `docs/cursor-report-19.md`

### Degistirilen dosyalar

- `packages/db/src/types.ts`
- `packages/db/src/index.ts`
- `apps/api/src/main.ts`
- `apps/mqtt-worker/src/main.ts`
- `apps/mqtt-worker/package.json`
- `packages/mqtt/src/topic.ts`
- `README.md`

## Neden boyle yaptin

- Command olusturma (API) ve command gonderme (worker) sorumluluklarini ayirarak moduler ve production-oriented bir akis saglandi.
- `command_events` ile audit/debug gorunurlugu artirildi.
- Worker icinde publish+ack+verify adimlari acik status gecisleriyle tutuldu, sessiz hata birakilmadi.
- Gercek cihaz olmadan lifecycle test edilebilmesi icin fake ack listener eklendi.

## Eksik kalanlar

- Queue tabanli dagitik dispatch yok (bilerek).
- Rule engine yok (bilerek).
- Gercek cihaz protokol edge-case handling sinirli.

## Sonraki onerilen adim

- Command timeout ve retry politikalari eklenmeli (or. `ack_timeout`, `verify_timeout`, yeniden deneme sayisi) ve bunlar da `command_events` ile izlenmeli.
