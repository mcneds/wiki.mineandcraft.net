ALTER TABLE music_submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'disc' CHECK(kind IN ('disc','head'));
ALTER TABLE music_submissions ADD COLUMN head_id TEXT REFERENCES sound_heads(id);
ALTER TABLE music_submissions ADD COLUMN head_owned INTEGER NOT NULL DEFAULT 0 CHECK(head_owned IN (0,1));
ALTER TABLE music_files ADD COLUMN duration_ms REAL;
ALTER TABLE music_files ADD COLUMN validation TEXT NOT NULL DEFAULT 'pending' CHECK(validation IN ('pending','valid','invalid'));
CREATE TABLE sound_heads (
  id TEXT PRIMARY KEY,
  minecraft_id TEXT NOT NULL UNIQUE,
  target_uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  edition TEXT NOT NULL CHECK(edition IN ('java','bedrock')),
  head_png TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  author_id TEXT NOT NULL,
  active_id TEXT REFERENCES music_submissions(id),
  pending_id TEXT REFERENCES music_submissions(id),
  suppressed INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE head_whitelist (uuid TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE head_whitelist_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), received INTEGER NOT NULL DEFAULT 0);
INSERT INTO head_whitelist_snapshot(id) VALUES(1);
CREATE UNIQUE INDEX head_pending_revision ON music_submissions(head_id) WHERE kind='head' AND status IN ('pending','rejected','approved');
CREATE TRIGGER head_submission_valid BEFORE INSERT ON music_submissions WHEN NEW.kind='head' BEGIN
  SELECT CASE WHEN NEW.source_kind!='file' OR NEW.head_id IS NULL OR NOT EXISTS(SELECT 1 FROM sound_heads WHERE id=NEW.head_id)
    THEN RAISE(ABORT,'head_invalid') END;
  SELECT CASE WHEN (SELECT received FROM head_whitelist_snapshot WHERE id=1)<unixepoch('now')*1000-120000
    THEN RAISE(ABORT,'head_whitelist_stale') END;
  SELECT CASE WHEN NEW.head_owned=0 AND EXISTS(SELECT 1 FROM head_whitelist w JOIN sound_heads h ON h.target_uuid=w.uuid WHERE h.id=NEW.head_id)
    THEN RAISE(ABORT,'head_protected') END;
END;
CREATE TRIGGER head_pending_created AFTER INSERT ON music_submissions WHEN NEW.kind='head' BEGIN
  UPDATE sound_heads SET pending_id=NEW.id,author_id=CASE WHEN active_id IS NULL THEN NEW.author_id ELSE author_id END,version=version+1 WHERE id=NEW.head_id;
END;
CREATE TRIGGER head_pending_deleted AFTER UPDATE OF status ON music_submissions WHEN NEW.kind='head' AND NEW.status='deleted' BEGIN
  UPDATE sound_heads SET pending_id=NULL,version=version+1 WHERE id=NEW.head_id AND pending_id=NEW.id;
END;
CREATE TRIGGER head_review_valid BEFORE UPDATE OF status ON music_submissions
WHEN NEW.kind='head' AND NEW.status IN ('approved','released') BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM music_files WHERE submission_id=NEW.id AND state='ready' AND validation='valid' AND duration_ms>0 AND duration_ms<=10000)
    THEN RAISE(ABORT,'head_audio_unvalidated') END;
  SELECT CASE WHEN (SELECT received FROM head_whitelist_snapshot WHERE id=1)<unixepoch('now')*1000-120000
    THEN RAISE(ABORT,'head_whitelist_stale') END;
  SELECT CASE WHEN NEW.head_owned=0 AND EXISTS(SELECT 1 FROM head_whitelist w JOIN sound_heads h ON h.target_uuid=w.uuid WHERE h.id=NEW.head_id)
    THEN RAISE(ABORT,'head_protected') END;
END;
CREATE TRIGGER head_revision_installed AFTER UPDATE OF status ON music_submissions
WHEN NEW.kind='head' AND OLD.status='approved' AND NEW.status='released' BEGIN
  UPDATE sound_heads SET active_id=NEW.id,pending_id=NULL,author_id=NEW.author_id,suppressed=0,version=version+1 WHERE id=NEW.head_id;
  UPDATE music_submissions SET status='deleted',updated=NEW.updated,version=version+1 WHERE head_id=NEW.head_id AND id!=NEW.id AND status='released';
END;
DROP TRIGGER music_catalogue_changed;
CREATE TRIGGER music_catalogue_changed AFTER UPDATE OF status,title,artist,source_kind,source_url,audio_source_url ON music_submissions
WHEN ((NEW.kind='disc' AND (OLD.status IN ('approved','released') OR NEW.status IN ('approved','released')))
 OR (NEW.kind='head' AND (OLD.status='approved' OR NEW.status='approved')))
 AND NOT (OLD.status='approved' AND NEW.status='released' AND OLD.title=NEW.title AND OLD.artist=NEW.artist AND OLD.source_kind=NEW.source_kind AND OLD.source_url IS NEW.source_url AND OLD.audio_source_url IS NEW.audio_source_url)
BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
CREATE TRIGGER head_suppression_changed AFTER UPDATE OF suppressed ON sound_heads WHEN OLD.suppressed!=NEW.suppressed AND OLD.active_id IS NEW.active_id
BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
CREATE TRIGGER head_profile_changed AFTER UPDATE OF name,profile_json ON sound_heads
WHEN NEW.active_id IS NOT NULL AND (OLD.name!=NEW.name OR OLD.profile_json!=NEW.profile_json)
BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
-- Replacements use the association's slot; both files count against byte storage until installation.
DROP TRIGGER music_submission_quota;
CREATE TRIGGER music_submission_quota BEFORE INSERT ON music_submissions
WHEN (SELECT count(*) FROM music_submissions s WHERE author_id=NEW.author_id AND status!='deleted'
 AND (kind='disc' OR NOT EXISTS(SELECT 1 FROM music_submissions n WHERE n.head_id=s.head_id AND n.author_id=s.author_id AND n.id!=s.id AND n.status IN ('pending','rejected','approved'))))>=25
 AND NOT (NEW.kind='head' AND EXISTS(SELECT 1 FROM music_submissions WHERE head_id=NEW.head_id AND author_id=NEW.author_id AND status='released'))
BEGIN SELECT RAISE(ABORT,'music_track_quota'); END;
