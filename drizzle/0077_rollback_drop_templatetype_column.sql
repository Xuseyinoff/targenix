-- Rollback for 0077 — re-create destinations.templateType.
-- Pre-drop column values are NOT recovered (they're gone from the heap);
-- every row gets the historic default `"custom"` sentinel.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND column_name = 'templateType'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE destinations ADD COLUMN templateType VARCHAR(32) NOT NULL DEFAULT ''custom''',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
