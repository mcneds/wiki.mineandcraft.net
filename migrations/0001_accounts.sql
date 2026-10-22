CREATE TABLE players (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  edition TEXT NOT NULL DEFAULT 'unknown' CHECK (edition IN ('java', 'bedrock', 'unknown')),
  minecraft_id TEXT UNIQUE,
  image TEXT NOT NULL,
  head_png TEXT,
  markdown TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'import'
);
CREATE TABLE revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES players(slug),
  version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  name TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created TEXT NOT NULL,
  UNIQUE(slug, version)
);
CREATE TRIGGER player_created AFTER INSERT ON players BEGIN
  INSERT INTO revisions(slug, version, markdown, name, author_id, created)
  VALUES (new.slug, new.version, new.markdown, new.name, new.updated_by, new.updated);
END;
CREATE TRIGGER player_updated AFTER UPDATE ON players BEGIN
  INSERT INTO revisions(slug, version, markdown, name, author_id, created)
  VALUES (new.slug, new.version, new.markdown, new.name, new.updated_by, new.updated);
END;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credentials TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX session_expiry ON sessions(expires);
CREATE TABLE oauth_states (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
