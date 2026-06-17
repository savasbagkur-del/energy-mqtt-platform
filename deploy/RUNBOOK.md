# Operasyon Runbook'u

Bu doküman platformu canlıda çalıştıran kişi içindir: deploy, yedekleme/geri yükleme,
sağlık kontrolü, güvenlik işlemleri ve olay müdahale adımları.

İlgili dosyalar: `deploy/bootstrap.sh`, `deploy/backup.sh`, `deploy/restore.sh`,
`docker-compose.prod.yml`, `deploy/README-deploy.md`.

---

## 1. Mimari özet

| Servis | Rol | Sağlık |
|---|---|---|
| `emqx` | MQTT broker | `emqx ctl status` (compose healthcheck) |
| `api` | REST API + kontrol/yönetim UI'leri | `GET /health`, `/ready`, `/metrics` |
| `mqtt-worker` | Mesaj işleme, komut orkestrasyonu, reconciler | `GET :9100/health`, `/ready`, `/metrics` |
| PostgreSQL | Kalıcı durum (harici / RDS) | `pg_isready` veya API `/ready` |

Tüm kalıcı durum **PostgreSQL**'de. EMQX oturumları/retained mesajları geçicidir; kritik
veri DB'dedir. Yedekleme = PostgreSQL yedeği.

---

## 2. Deploy ve güncelleme

İlk kurulum ve sonraki güncellemeler:

```bash
cd /opt/communication-mvp
git pull                      # yeni sürüm
./deploy/bootstrap.sh         # build + migrate + up -d + health check
```

`bootstrap.sh` sırayla: imajları build eder, migration'ı çalıştırır, stack'i ayağa kaldırır,
API ve worker `/health` uçlarını bekler. Health başarısızsa çıkış kodu 1 verir ve log komutunu yazar.

Manuel:

```bash
COMPOSE="docker compose --env-file .env.production -f docker-compose.prod.yml"
$COMPOSE build
$COMPOSE run --rm migrate
$COMPOSE up -d
$COMPOSE ps
```

---

## 3. Veritabanı migration

Migration'lar `packages/db/migrations/` altında ve sıralı çalışır; uygulananlar kayıt altına
alınır (tekrar çalıştırmak güvenlidir).

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate
```

Yeni şema kolonları eklemelidir (additive). Eski kod yeni kolonlarla çalışmaya devam eder,
bu yüzden migration'ı yeni sürümü `up` etmeden önce çalıştırmak güvenlidir.

---

## 4. Yedekleme ve geri yükleme

### Yedek alma

```bash
./deploy/backup.sh
# -> backups/<db>_<YYYYMMDD_HHMMSS>.dump  (custom/compressed format)
```

- `.env.production` içindeki `POSTGRES_*` değerlerini kullanır.
- Tek seferlik `postgres:16-alpine` container'ı ile `pg_dump -Fc` çalıştırır (host'a istemci gerekmez).
- `BACKUP_RETENTION_DAYS` (varsayılan 14) günden eski yedekleri siler.
- `PG_IMAGE` sunucunun major sürümüne **eşit veya büyük** olmalı (ör. RDS 17 ise `postgres:17-alpine`).

### Zamanlama (cron — günlük 02:30)

```cron
30 2 * * * cd /opt/communication-mvp && ./deploy/backup.sh >> /var/log/db-backup.log 2>&1
```

> Yedekleri ayrıca site dışına (örn. S3) kopyalayın: `aws s3 cp backups/ s3://<bucket>/db/ --recursive`.

### Geri yükleme (DİKKAT: yıkıcı)

```bash
./deploy/restore.sh backups/<db>_<timestamp>.dump
# DB adını yazarak onay istenir; otomasyonda FORCE=1 kullanın.
```

`pg_restore --clean --if-exists` ile nesneleri düşürüp yeniden yükler. Yedek eski şemadaysa
geri yüklemeden sonra migration'ı tekrar çalıştırın.

### Geri yükleme tatbikatı (önerilir)

Üç ayda bir, son yedeği ayrı bir DB'ye geri yükleyip `GET /ready` ve birkaç `GET /devices`
çağrısıyla doğrulayın. Test edilmemiş yedek = yedek yok.

---

## 5. Sağlık ve gözlemlenebilirlik

```bash
curl http://127.0.0.1:3000/health     # API canlı mı
curl http://127.0.0.1:3000/ready      # API + DB hazır mı (gerçek DB ping)
curl http://127.0.0.1:3000/metrics    # API metrikleri
curl http://127.0.0.1:9100/health     # worker canlı mı
curl http://127.0.0.1:9100/ready      # worker: DB+MQTT bağlı, döngüler taze mi
curl http://127.0.0.1:9100/metrics    # Prometheus formatı (komut/alarm sayaçları dahil)
```

- `/ready` 200 değilse: DB bağlantısı, MQTT bağlantısı veya işleme döngülerinden biri bayat
  (bkz. `WORKER_READY_MAX_LOOP_AGE_SEC`).
- Loglar: `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f <servis>`.

---

## 6. Güvenlik işlemleri

### API token rotasyonu

1. Yeni token üret: `openssl rand -hex 32`.
2. `.env.production` içinde `API_AUTH_TOKEN`'ı güncelle.
3. `... up -d api` ile API'yi yeniden başlat.
4. İstemcileri/UI token alanını yeni değerle güncelle. (Token boşsa auth devre dışıdır — üretimde asla boş bırakma.)

### Cihaz whitelist'i açma

1. `.env.production`: `DEVICE_WHITELIST_ENABLED=true`.
2. Worker'ı yeniden başlat: `... up -d mqtt-worker`.
3. Bundan sonra **bilinmeyen** SN'ler bağlanınca `quarantined` (karantina) olur — panelde görünür
   ama komut gönderilemez (403 `device_not_registered`).
4. Karantinadaki cihazları yönet: `devices.html` → "Karantina" filtresi → **Onayla**, veya
   `POST /registry/devices/:sn/approve`.
5. Toplu kayıt: `devices.html` → "CSV İçe Aktar" veya `POST /registry/devices/import`.

> Whitelist açmadan önce mevcut gerçek cihazları kaydetmeyi unutmayın (önceki otomatik kayıtlar
> `auto` durumundadır ve yönetilmeye devam eder; yalnızca **yeni** bilinmeyen SN'ler karantinaya alınır).

---

## 7. Olay müdahale (playbook'lar)

### Worker sürekli yeniden başlıyor (crash loop)
1. `... logs --tail=100 mqtt-worker` → hata mesajını bul.
2. DB/MQTT ulaşılabilir mi? (`/ready` 503 ise alttaki bağımlılığı kontrol et.)
3. Son deploy mu kırdı? → Bölüm 9 (rollback).

### `/ready` 503 / DB bağlantı hatası
1. RDS ayakta mı, security group EC2'den 5432'ye izin veriyor mu?
2. `.env.production` POSTGRES_* doğru mu?
3. RDS bağlantı limiti dolmuş olabilir → worker/api replica sayısını veya pool boyutunu düşür.

### Cihazlar bağlanmıyor / MQTT down
1. `... ps emqx` ve `... logs emqx`.
2. EMQX dashboard `:18083` → bağlı istemci sayısı.
3. 1883 portu security group'ta cihaz ağlarına açık mı?

### Komutlar `verify_pending`'de takılıyor
- Cihaz `SwitchSta` yollamıyorsa durum `AdfState1`/`PRESTATE` alanlarından decode edilir.
  `/devices/:sn/control-view` ile son telemetriyi ve decode sonucunu kontrol et. Reconciler
  cihaz onaylayana kadar (adaptif zamanlamayla) sürdürür; cihaz uzun süre offline ise alarm webhook'u tetiklenir.

### Yüksek gecikme / birikme
- Worker `/metrics` → işleme döngüsü tazeliği ve komut sayaçları.
- Gerekirse worker'ı yatay ölçekle (Bölüm 8).

### Disk doluyor
- `backups/` retention'ı kontrol et, eski yedekleri S3'e taşı.
- EMQX `/opt/emqx/log` ve docker log boyutu (`docker system df`).

---

## 8. Ölçekleme

Worker, EMQX **shared subscription** (`$share`) ile yatay ölçeklenebilir; her komut/mesaj tek
worker tarafından işlenir (atomik claim + advisory lock ile çift işleme engellenir).

1. `.env.production`: `MQTT_SHARED_GROUP=workers` (boş değilse shared subscription aktif).
2. `docker compose ... up -d --scale mqtt-worker=N` (her replica için ayrı `WORKER_HEALTH_PORT`/
   `MQTT_CLIENT_ID` gerektiğine dikkat; tek host'ta port çakışmasını önlemek için ayrı compose
   override veya ayrı hostlar kullanın).

---

## 9. Geri alma (rollback)

```bash
git log --oneline -n 10          # hedef sürümü bul
git checkout <iyi-commit>
./deploy/bootstrap.sh            # önceki sürümü yeniden build + deploy et
```

Migration'lar additive olduğundan kod rollback'i genelde DB rollback gerektirmez. Veri bozulması
varsa Bölüm 4'teki yedekten geri yükleyin.

---

## 10. Hızlı komut referansı

```bash
COMPOSE="docker compose --env-file .env.production -f docker-compose.prod.yml"
$COMPOSE ps                      # durum
$COMPOSE logs -f mqtt-worker     # canlı log
$COMPOSE restart api             # tek servis yeniden başlat
$COMPOSE up -d --scale mqtt-worker=3
./deploy/backup.sh               # yedek al
./deploy/restore.sh <dump>       # geri yükle (yıkıcı)
```

---

## 11. AWS kurulum checklist (Dalga 4)

Sıralı adımlar. Doğrulama: imaj build + migrate + up + healthcheck zinciri yerelde uçtan uca
test edildi; aşağıdakiler bunu gerçek altyapıya taşır.

1. **RDS PostgreSQL** oluştur (16+). Sadece EC2 security group'undan 5432'ye izin ver. Endpoint,
   db adı, kullanıcı, parolayı not al.
2. **EC2** (Ubuntu 22.04 / Amazon Linux 2023) oluştur. Docker Engine + Compose plugin kur.
3. **Security group (EC2)** inbound:
   - `22/tcp` → sadece admin IP
   - `443/tcp` → API kullanıcı ağı (nginx TLS); `80/tcp` → 443'e yönlendirme
   - `8883/tcp` → cihaz ağları (MQTT over TLS) — düz `1883`'ü mümkünse dışa açma
   - `18083/tcp` → EMQX dashboard, sadece admin IP
4. Kodu sunucuya al (`/opt/communication-mvp`), `.env.production.example` → `.env.production` kopyala, doldur:
   - `POSTGRES_*` (RDS), güçlü `POSTGRES_PASSWORD`
   - `API_AUTH_TOKEN` = `openssl rand -hex 32`
   - `MQTT_USERNAME`/`MQTT_PASSWORD` (güçlü), `MQTT_CLIENT_ID` benzersiz
   - `DEVICE_WHITELIST_ENABLED` (gerçek cihazları kaydettikten sonra `true`)
5. **TLS sertifikası**: domain → API için sertifika al (Let's Encrypt/ACM). `fullchain.pem` +
   `privkey.pem` dosyalarını `infra/nginx/certs/` altına koy.
6. **EMQX güvenliği** (Bölüm 12) — kimlik doğrulamayı aç ve cihaz kimlik bilgilerini ekle, TLS cert'i değiştir.
7. **Başlat**: `./deploy/bootstrap.sh` (build + migrate + up + health). TLS proxy için:
   `docker compose --env-file .env.production -f docker-compose.prod.yml --profile tls up -d`
8. **Doğrula**: `curl https://<domain>/health`, `/ready`; EMQX dashboard'da cihaz bağlantısı; worker `:9100/ready`.
9. **Yedekleme cron'u** kur (Bölüm 4). Yedekleri S3'e kopyala.
10. **Gerçek cihazları kaydet** (`devices.html` veya CSV import), sonra whitelist'i aç ve worker'ı yeniden başlat.

> API'yi yalnızca nginx üzerinden erişilebilir kılmak için `docker-compose.prod.yml`'de api port
> eşlemesini `"127.0.0.1:${API_PORT}:3000"` yap (dışarıdan doğrudan 3000 kapanır).

---

## 12. EMQX güvenliği ve MQTT TLS

EMQX 5.x'te kimlik doğrulama **authenticator zinciri** ile yapılır; compose env'inde
`allow_anonymous=false` tek başına TÜM bağlantıları (worker dahil) reddeder — yapma.

**Kimlik doğrulamayı açma (built-in database):**
1. Dashboard → `http://<EC2_IP>:18083` (giriş: `.env.production` MQTT_USERNAME/PASSWORD).
2. Access Control → Authentication → Create → **Password-Based: Built-in Database**.
3. Authentication → Users → cihazlar ve worker için kullanıcı/parola ekle (worker'ın
   `MQTT_USERNAME`/`MQTT_PASSWORD` değerleriyle eşleşmeli).
4. (Opsiyonel) Access Control → Authorization (ACL) ile her client'ı kendi topic ön ekine kısıtla.

> Alternatif: `infra/emqx/` altına bir `emqx.conf`/`acl` mount edip kod ile yönet (GitOps). MVP için
> dashboard yeterli; kalıcılık için EMQX `data/` hacmi zaten mount'lu (`/opt/emqx/data`).

**MQTT over TLS (8883):** EMQX self-signed cert ile 8883'te hazır gelir. Üretim için bundled cert'i
gerçek sertifikayla değiştir (`/opt/emqx/etc/certs/` altına mount) ve cihazları 8883'e yönlendir.

**API → EMQX:** worker/api compose ağında `MQTT_HOST=emqx` ile bağlanır; tek-host kurulumda
`MQTT_HOST` EMQX servis adıdır. Ayrı broker (örn. mevcut `51.20.106.176`) kullanıyorsan oraya yönlendir.
