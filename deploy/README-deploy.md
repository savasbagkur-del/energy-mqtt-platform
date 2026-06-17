# Independent Deployment v1

Bu dokuman ilk production modeli icindir:

- Tek EC2 uzerinde Docker Compose
- RDS PostgreSQL ayri
- EMQX + API + mqtt-worker ayni EC2 uzerinde

## 1) EC2 Hazirligi

1. Ubuntu 22.04 LTS veya Amazon Linux 2023 sec.
2. Sunucuya Docker Engine ve Docker Compose plugin kur.
3. Proje kodunu sunucuya al (ornek: `/opt/communication-mvp`).
4. `.env.production.example` dosyasini `.env.production` olarak kopyala ve degerleri doldur.

## 2) Security Group Onerisi

Asgari inbound kurallari:

- `22/tcp` -> sadece admin IP
- `3000/tcp` -> API kullanimina gore kisitli ag
- `1883/tcp` -> MQTT client aglari
- `18083/tcp` -> EMQX dashboard (mumkunse sadece admin IP)

RDS tarafinda:

- `5432/tcp` sadece EC2 security group'tan izinli olsun.

## 3) RDS Bilgileri Nereye Yazilir

`/opt/communication-mvp/.env.production` icinde:

- `POSTGRES_HOST` = RDS endpoint
- `POSTGRES_PORT` = genelde `5432`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

## 4) Deploy Komutlari

```bash
cd /opt/communication-mvp
chmod +x deploy/bootstrap.sh
./deploy/bootstrap.sh
```

Alternatif manuel:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

## 5) Saglik Kontrolu

- API health: `curl http://<EC2_IP>:3000/health`
- API ready: `curl http://<EC2_IP>:3000/ready`
- EMQX dashboard: `http://<EC2_IP>:18083`

Log kontrolu:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f mqtt-worker
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f emqx
```

## 6) Yedekleme / Geri Yukleme

```bash
./deploy/backup.sh                 # backups/<db>_<timestamp>.dump (gunluk cron onerilir)
./deploy/restore.sh <dump>         # YIKICI: DB adini yazarak onay ister (FORCE=1 ile otomatik)
```

Detaylar, zamanlama (cron) ve geri yukleme tatbikati icin: `deploy/RUNBOOK.md` Bolum 4.

## 7) Operasyon Runbook'u

Deploy, saglik kontrolu, guvenlik (token rotasyonu, whitelist), olay mudahale ve olcekleme
icin kapsamli rehber: **`deploy/RUNBOOK.md`**.

## 8) EMQX Edition Notu

Production oncesi EMQX icin edition/lisans karari netlestirilmelidir (Community vs Enterprise).
