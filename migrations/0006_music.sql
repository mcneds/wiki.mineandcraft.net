CREATE TABLE music_submissions (
  id TEXT PRIMARY KEY,
  poster_slug TEXT NOT NULL REFERENCES players(slug),
  author_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  artist TEXT NOT NULL DEFAULT '' CHECK(length(artist)<=100),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('file','spotify','youtube')),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','released','rejected','deleted')),
  review_note TEXT NOT NULL DEFAULT '' CHECK(length(review_note)<=500),
  version INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  CHECK((source_kind='file' AND source_url IS NULL) OR (source_kind!='file' AND source_url IS NOT NULL))
);
CREATE INDEX music_author ON music_submissions(author_id,status);
CREATE INDEX music_status ON music_submissions(status,created);
CREATE TRIGGER music_submission_quota BEFORE INSERT ON music_submissions
  WHEN (SELECT count(*) FROM music_submissions WHERE author_id=NEW.author_id AND status!='deleted')>=25
  BEGIN SELECT RAISE(ABORT,'music_track_quota'); END;
CREATE TABLE music_files (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES music_submissions(id),
  author_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  extension TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=20971520),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','ready','deleting','deleted')),
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX music_active_file ON music_files(submission_id) WHERE state!='deleted';
CREATE INDEX music_file_cleanup ON music_files(state,created);
CREATE TRIGGER music_file_quota BEFORE INSERT ON music_files
  WHEN NEW.bytes+(SELECT coalesce(sum(bytes),0) FROM music_files WHERE author_id=NEW.author_id AND state!='deleted')>104857600
  BEGIN SELECT RAISE(ABORT,'music_file_quota'); END;
CREATE TRIGGER music_file_pending BEFORE INSERT ON music_files
  WHEN NOT EXISTS(SELECT 1 FROM music_submissions WHERE id=NEW.submission_id AND author_id=NEW.author_id AND (status IN ('pending','rejected') OR (status='approved' AND source_kind='youtube')))
  BEGIN SELECT RAISE(ABORT,'music_not_pending'); END;
CREATE TRIGGER music_review_ready BEFORE UPDATE OF status ON music_submissions
  WHEN NEW.status IN ('approved','released') AND (
    EXISTS(SELECT 1 FROM music_files WHERE submission_id=NEW.id AND state IN ('uploading','deleting'))
    OR (NEW.source_kind!='youtube' AND NOT EXISTS(SELECT 1 FROM music_files WHERE submission_id=NEW.id AND state='ready'))
  ) BEGIN SELECT RAISE(ABORT,'music_audio_required'); END;
CREATE TABLE music_delivery (
  id INTEGER PRIMARY KEY CHECK(id=1),
  heartbeat INTEGER,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','installed','failed')),
  release_id TEXT,
  catalogue_version INTEGER NOT NULL DEFAULT 0,
  installed_catalogue_version INTEGER,
  message TEXT NOT NULL DEFAULT ''
);
INSERT INTO music_delivery(id) VALUES(1);
CREATE TRIGGER music_catalogue_changed AFTER UPDATE ON music_submissions
  WHEN (OLD.status IN ('approved','released') OR NEW.status IN ('approved','released'))
    AND NOT (OLD.status='approved' AND NEW.status='released' AND OLD.title=NEW.title AND OLD.artist=NEW.artist AND OLD.source_kind=NEW.source_kind AND OLD.source_url IS NEW.source_url)
  BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
CREATE TRIGGER music_catalogue_audio AFTER UPDATE OF state ON music_files
  WHEN (OLD.state='ready' OR NEW.state='ready') AND EXISTS(SELECT 1 FROM music_submissions WHERE id=NEW.submission_id AND status IN ('approved','released'))
  BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
CREATE TRIGGER music_install_snapshot BEFORE UPDATE OF installed_catalogue_version ON music_delivery
  WHEN NEW.installed_catalogue_version!=NEW.catalogue_version
  BEGIN SELECT RAISE(ABORT,'music_catalogue_changed'); END;
