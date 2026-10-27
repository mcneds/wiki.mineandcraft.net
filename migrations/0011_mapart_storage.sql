ALTER TABLE mapart_limits ADD COLUMN storage_limit_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK(storage_limit_bytes>0);
ALTER TABLE mapart_attempts ADD COLUMN bytes INTEGER NOT NULL DEFAULT 11534336 CHECK(bytes>=0);
ALTER TABLE mapart_attempts ADD COLUMN size_checked INTEGER NOT NULL DEFAULT 0 CHECK(size_checked IN (0,1));
CREATE INDEX mapart_attempt_job ON mapart_attempts(job_id);
-- Existing attempts are conservatively charged until their private R2 sizes are measured.
UPDATE mapart_attempts SET bytes=11534336,size_checked=0;
CREATE VIEW mapart_storage AS
SELECT j.author_id,COALESCE(SUM(a.bytes),0) AS bytes
FROM mapart_jobs j LEFT JOIN mapart_attempts a ON a.job_id=j.id GROUP BY j.author_id;
DROP TRIGGER mapart_quota;
CREATE TRIGGER mapart_quota BEFORE INSERT ON mapart_jobs WHEN
  (SELECT count(*) FROM mapart_jobs WHERE author_id=NEW.author_id AND status IN ('uploading','queued','converting'))>=(SELECT pending_limit FROM mapart_limits WHERE id=1)
BEGIN SELECT RAISE(ABORT,'mapart_quota'); END;
CREATE TRIGGER mapart_storage_create BEFORE INSERT ON mapart_jobs WHEN
  COALESCE((SELECT bytes FROM mapart_storage WHERE author_id=NEW.author_id),0)>=(SELECT storage_limit_bytes FROM mapart_limits WHERE id=1)
BEGIN SELECT RAISE(ABORT,'mapart_storage_quota'); END;
CREATE TRIGGER mapart_storage_insert BEFORE INSERT ON mapart_attempts WHEN NEW.bytes>0 AND
  COALESCE((SELECT bytes FROM mapart_storage WHERE author_id=(SELECT author_id FROM mapart_jobs WHERE id=NEW.job_id)),0)+NEW.bytes>(SELECT storage_limit_bytes FROM mapart_limits WHERE id=1)
BEGIN SELECT RAISE(ABORT,'mapart_storage_quota'); END;
CREATE TRIGGER mapart_storage_update BEFORE UPDATE OF bytes ON mapart_attempts WHEN NEW.bytes>OLD.bytes AND
  COALESCE((SELECT bytes FROM mapart_storage WHERE author_id=(SELECT author_id FROM mapart_jobs WHERE id=NEW.job_id)),0)-OLD.bytes+NEW.bytes>(SELECT storage_limit_bytes FROM mapart_limits WHERE id=1)
BEGIN SELECT RAISE(ABORT,'mapart_storage_quota'); END;
