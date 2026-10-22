ALTER TABLE oauth_states ADD COLUMN return_to TEXT NOT NULL DEFAULT '/account/';
CREATE TABLE coordinate_entries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  access TEXT NOT NULL CHECK(access IN ('public','private')),
  dimension TEXT,
  x INTEGER, y INTEGER, z INTEGER,
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=2000),
  poster_slug TEXT NOT NULL REFERENCES players(slug),
  author_id TEXT NOT NULL,
  image_id TEXT REFERENCES media(id),
  image_alt TEXT NOT NULL DEFAULT '' CHECK(length(image_alt)<=300),
  tags_json TEXT NOT NULL CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
  owners_json TEXT NOT NULL CHECK(json_valid(owners_json) AND json_type(owners_json)='array'),
  version INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  CHECK((access='private' AND dimension IS NULL AND x IS NULL AND y IS NULL AND z IS NULL)
    OR (access='public' AND dimension IS NOT NULL AND dimension IN ('overworld','nether','end') AND x IS NOT NULL AND z IS NOT NULL AND typeof(x)='integer' AND typeof(z)='integer' AND (y IS NULL OR typeof(y)='integer')))
);
CREATE INDEX coordinates_name ON coordinate_entries(name COLLATE NOCASE,id);
CREATE INDEX coordinates_author ON coordinate_entries(author_id);
CREATE TABLE coordinate_tags (
  entry_id TEXT NOT NULL REFERENCES coordinate_entries(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(entry_id,tag)
);
CREATE INDEX coordinate_tag_filter ON coordinate_tags(tag,entry_id);
CREATE TABLE coordinate_owners (
  entry_id TEXT NOT NULL REFERENCES coordinate_entries(id) ON DELETE CASCADE,
  player_slug TEXT NOT NULL REFERENCES players(slug),
  PRIMARY KEY(entry_id,player_slug)
);
-- Relations change in the same statement as the version-checked entry update.
CREATE TRIGGER coordinate_created AFTER INSERT ON coordinate_entries BEGIN
  INSERT INTO coordinate_tags SELECT NEW.id,value FROM json_each(NEW.tags_json);
  INSERT INTO coordinate_owners SELECT NEW.id,value FROM json_each(NEW.owners_json);
END;
CREATE TRIGGER coordinate_updated AFTER UPDATE OF tags_json,owners_json ON coordinate_entries BEGIN
  DELETE FROM coordinate_tags WHERE entry_id=NEW.id;
  DELETE FROM coordinate_owners WHERE entry_id=NEW.id;
  INSERT INTO coordinate_tags SELECT NEW.id,value FROM json_each(NEW.tags_json);
  INSERT INTO coordinate_owners SELECT NEW.id,value FROM json_each(NEW.owners_json);
END;
CREATE TRIGGER coordinate_image_insert BEFORE INSERT ON coordinate_entries
  WHEN NEW.image_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM media WHERE id=NEW.image_id AND slug=NEW.poster_slug AND state='ready')
  BEGIN SELECT RAISE(ABORT,'coordinate_image_unavailable'); END;
CREATE TRIGGER coordinate_image_update BEFORE UPDATE ON coordinate_entries
  WHEN NEW.image_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM media WHERE id=NEW.image_id AND slug=NEW.poster_slug AND state='ready')
  BEGIN SELECT RAISE(ABORT,'coordinate_image_unavailable'); END;
DROP TRIGGER media_in_use;
CREATE TRIGGER media_in_use BEFORE UPDATE OF state ON media
  WHEN NEW.state IN ('deleting','deleted') AND (
    EXISTS(SELECT 1 FROM players,json_each(players.media_refs) WHERE json_each.value=OLD.id)
    OR EXISTS(SELECT 1 FROM coordinate_entries WHERE image_id=OLD.id)
  ) BEGIN SELECT RAISE(ABORT,'media_in_use'); END;
