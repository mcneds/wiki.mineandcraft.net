ALTER TABLE music_submissions ADD COLUMN audio_source_url TEXT
  CHECK(audio_source_url IS NULL OR source_kind='spotify');

DROP TRIGGER music_review_ready;
CREATE TRIGGER music_review_ready BEFORE UPDATE OF status ON music_submissions
  WHEN NEW.status IN ('approved','released') AND (
    EXISTS(SELECT 1 FROM music_files WHERE submission_id=NEW.id AND state IN ('uploading','deleting'))
    OR (NOT EXISTS(SELECT 1 FROM music_files WHERE submission_id=NEW.id AND state='ready')
      AND NOT (NEW.source_kind='youtube' OR (NEW.source_kind='spotify' AND NEW.audio_source_url IS NOT NULL)))
  ) BEGIN SELECT RAISE(ABORT,'music_audio_required'); END;

DROP TRIGGER music_file_pending;
CREATE TRIGGER music_file_pending BEFORE INSERT ON music_files
  WHEN NOT EXISTS(SELECT 1 FROM music_submissions WHERE id=NEW.submission_id AND author_id=NEW.author_id
    AND (status IN ('pending','rejected') OR (status='approved' AND
      (source_kind='youtube' OR (source_kind='spotify' AND audio_source_url IS NOT NULL)))))
  BEGIN SELECT RAISE(ABORT,'music_not_pending'); END;

DROP TRIGGER music_catalogue_changed;
CREATE TRIGGER music_catalogue_changed AFTER UPDATE ON music_submissions
  WHEN (OLD.status IN ('approved','released') OR NEW.status IN ('approved','released'))
    AND NOT (OLD.status='approved' AND NEW.status='released' AND OLD.title=NEW.title
      AND OLD.artist=NEW.artist AND OLD.source_kind=NEW.source_kind
      AND OLD.source_url IS NEW.source_url AND OLD.audio_source_url IS NEW.audio_source_url)
  BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
