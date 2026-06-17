-- Faz C: Cihaz-basina uyarlanabilir zamanlama (adaptive timing).
--  device_cadence_stats : her cihazin yeniden-baglanma (login) ritmini ogrenir.
--  Ogrenilen EWMA reconnect araligi, komut policy_snapshot'ina (ack/retry/delivery/ttl) ve
--  reconciler backoff'una merge edilir -> uykudaki/hucresel cihazlarda bosa gonderim azalir,
--  TTL erken dolup komut "expired" olmaz, retry'lar cihazin uyanma penceresine denk gelir.

CREATE TABLE IF NOT EXISTS device_cadence_stats (
  sn                  TEXT PRIMARY KEY,
  product_key         TEXT NULL,
  -- Ardisik login (reconnect) olaylari arasi sureden ogrenilen ritim (saniye).
  ewma_reconnect_sec  DOUBLE PRECISION NULL,   -- ussel agirlikli hareketli ortalama (alpha=0.3)
  last_gap_sec        DOUBLE PRECISION NULL,   -- son gozlenen reconnect araligi
  min_gap_sec         DOUBLE PRECISION NULL,   -- gozlenen en kisa aralik
  max_gap_sec         DOUBLE PRECISION NULL,   -- gozlenen en uzun aralik (yavas decay'li)
  sample_count        INTEGER NOT NULL DEFAULT 0,  -- gecerli (saglikli) aralik ornek sayisi
  last_login_at       TIMESTAMPTZ NULL,        -- son login/reconnect ani
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE device_cadence_stats IS 'Cihaz-basina ogrenilen reconnect ritmi; adaptive command/reconciler timing icin kaynak.';
COMMENT ON COLUMN device_cadence_stats.ewma_reconnect_sec IS 'Login olaylari arasi sureden EWMA reconnect araligi (saniye).';
COMMENT ON COLUMN device_cadence_stats.sample_count IS 'Saglikli (5..1800 sn) gozlenen aralik sayisi; esik altinda adaptive uygulanmaz.';
