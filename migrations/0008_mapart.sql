CREATE TABLE mapart_limits (
  id INTEGER PRIMARY KEY CHECK(id=1),
  saved_limit INTEGER NOT NULL CHECK(saved_limit BETWEEN 1 AND 1000),
  pending_limit INTEGER NOT NULL CHECK(pending_limit BETWEEN 1 AND 100)
);
INSERT INTO mapart_limits VALUES(1,25,5);
CREATE TABLE mapart_jobs (
  id TEXT PRIMARY KEY,
  claim_code TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  poster_slug TEXT NOT NULL REFERENCES players(slug),
  minecraft_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  settings TEXT NOT NULL CHECK(json_valid(settings)),
  media_id TEXT REFERENCES media(id),
  source_state TEXT NOT NULL CHECK(source_state IN ('none','pending','receiving','ready','deleting','deleted')),
  source_sha256 TEXT,
  source_token TEXT,
  status TEXT NOT NULL CHECK(status IN ('uploading','queued','converting','ready','failed','deleted')),
  error TEXT NOT NULL DEFAULT '',
  lease TEXT,
  lease_until INTEGER,
  artifact_token TEXT,
  artifact_sha256 TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX mapart_author ON mapart_jobs(author_id,status);
CREATE INDEX mapart_queue ON mapart_jobs(status,created);
CREATE TABLE mapart_attempts (
  token TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES mapart_jobs(id),
  created INTEGER NOT NULL
);
CREATE TRIGGER mapart_source_available BEFORE INSERT ON mapart_jobs WHEN NEW.media_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM media WHERE id=NEW.media_id AND slug=NEW.poster_slug AND state='ready'
) BEGIN SELECT RAISE(ABORT,'mapart_media_unavailable'); END;
CREATE TRIGGER mapart_source_in_use BEFORE UPDATE OF state ON media WHEN NEW.state IN ('deleting','deleted') AND EXISTS(
  SELECT 1 FROM mapart_jobs WHERE media_id=OLD.id AND status IN ('uploading','queued','converting','failed')
) BEGIN SELECT RAISE(ABORT,'media_in_use'); END;
CREATE TRIGGER mapart_quota BEFORE INSERT ON mapart_jobs WHEN
  (SELECT count(*) FROM mapart_jobs WHERE author_id=NEW.author_id AND status!='deleted')>=(SELECT saved_limit FROM mapart_limits WHERE id=1)
  OR (SELECT count(*) FROM mapart_jobs WHERE author_id=NEW.author_id AND status IN ('uploading','queued','converting'))>=(SELECT pending_limit FROM mapart_limits WHERE id=1)
BEGIN SELECT RAISE(ABORT,'mapart_quota'); END;
CREATE TRIGGER mapart_retry_quota BEFORE UPDATE OF status ON mapart_jobs WHEN NEW.status='queued' AND OLD.status='failed'
  AND (SELECT count(*) FROM mapart_jobs WHERE author_id=NEW.author_id AND status IN ('uploading','queued','converting'))>=(SELECT pending_limit FROM mapart_limits WHERE id=1)
BEGIN SELECT RAISE(ABORT,'mapart_quota'); END;
