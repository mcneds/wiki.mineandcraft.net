ALTER TABLE players ADD COLUMN media_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(media_refs));
CREATE TABLE media_usage (
  slug TEXT PRIMARY KEY REFERENCES players(slug),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0 AND bytes <= 52428800)
);
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL REFERENCES players(slug),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 5242880),
  state TEXT NOT NULL CHECK(state IN ('pending','ready','deleting','deleted')),
  created INTEGER NOT NULL,
  author_id TEXT NOT NULL
);
CREATE INDEX media_player ON media(slug,state);
CREATE INDEX media_pending ON media(state,created);
CREATE TRIGGER media_reserve AFTER INSERT ON media WHEN NEW.state != 'deleted' BEGIN
  INSERT INTO media_usage(slug,bytes) VALUES(NEW.slug,NEW.bytes)
    ON CONFLICT(slug) DO UPDATE SET bytes=bytes+NEW.bytes;
END;
CREATE TRIGGER media_release AFTER UPDATE OF state ON media
  WHEN OLD.state != 'deleted' AND NEW.state = 'deleted' BEGIN
  UPDATE media_usage SET bytes=bytes-OLD.bytes WHERE slug=OLD.slug;
END;
-- These checks and page updates run in the same database transaction. A delete
-- cannot race a new reference, including a reference on another player's page.
CREATE TRIGGER media_in_use BEFORE UPDATE OF state ON media
  WHEN NEW.state IN ('deleting','deleted') AND EXISTS(
    SELECT 1 FROM players,json_each(players.media_refs) WHERE json_each.value=OLD.id
  ) BEGIN SELECT RAISE(ABORT,'media_in_use'); END;
CREATE TRIGGER media_page_update BEFORE UPDATE OF markdown,media_refs ON players
  WHEN EXISTS(SELECT 1 FROM media,json_each(NEW.media_refs) WHERE state != 'ready' AND json_each.value=media.id)
  BEGIN SELECT RAISE(ABORT,'media_unavailable'); END;
CREATE TRIGGER media_page_insert BEFORE INSERT ON players
  WHEN EXISTS(SELECT 1 FROM media,json_each(NEW.media_refs) WHERE state != 'ready' AND json_each.value=media.id)
  BEGIN SELECT RAISE(ABORT,'media_unavailable'); END;
