ALTER TABLE music_submissions ADD COLUMN cover_url TEXT CHECK(cover_url IS NULL OR length(cover_url)<=2048);

-- Website artwork does not change audio packs or restart delivery.
DROP TRIGGER music_catalogue_changed;
CREATE TRIGGER music_catalogue_changed AFTER UPDATE OF status,title,artist,source_kind,source_url,audio_source_url ON music_submissions
  WHEN (OLD.status IN ('approved','released') OR NEW.status IN ('approved','released'))
    AND NOT (OLD.status='approved' AND NEW.status='released' AND OLD.title=NEW.title
      AND OLD.artist=NEW.artist AND OLD.source_kind=NEW.source_kind
      AND OLD.source_url IS NEW.source_url AND OLD.audio_source_url IS NEW.audio_source_url)
  BEGIN UPDATE music_delivery SET catalogue_version=catalogue_version+1 WHERE id=1; END;
