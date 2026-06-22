-- Generic key/value store for operator-configured application settings that must be shared across
-- browsers/devices (e.g. billing chargeback config), instead of living in each browser's localStorage.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app_settings IS
  'Sunucu tarafinda paylasilan uygulama ayarlari (anahtar/deger). Ornek: billing = aylik maliyet + kar marji + para birimi.';
