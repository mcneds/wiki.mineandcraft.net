CREATE TABLE profile_comments (
  id TEXT PRIMARY KEY,
  profile_slug TEXT NOT NULL REFERENCES players(slug),
  poster_slug TEXT NOT NULL REFERENCES players(slug),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created TEXT NOT NULL
);
CREATE INDEX profile_comments_page ON profile_comments(profile_slug,created DESC,id DESC);
