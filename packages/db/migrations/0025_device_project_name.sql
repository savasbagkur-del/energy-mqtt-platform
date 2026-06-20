-- Per-device project/site name (e.g. "SavasEvi", "VeliEvi"). Used to group devices by
-- installation and to build the outbound meterName as "<project>-<model>-<sn>".
-- NULL/empty resolves to the placeholder "NA" in the app layer.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS project_name TEXT NULL;

COMMENT ON COLUMN devices.project_name IS
  'Proje/saha adi (ornek: SavasEvi). meterName = <project_name>-<model>-<sn> seklinde kullanilir; bos ise NA.';
