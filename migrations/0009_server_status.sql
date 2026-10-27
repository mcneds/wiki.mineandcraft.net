CREATE TABLE server_status (
  id INTEGER PRIMARY KEY CHECK(id=1),
  availability TEXT NOT NULL CHECK(availability IN ('online','offline','unavailable')),
  players TEXT NOT NULL DEFAULT '[]',
  capacity INTEGER NOT NULL DEFAULT 20,
  received INTEGER NOT NULL
);
CREATE TABLE music_progress (
  submission_id TEXT PRIMARY KEY REFERENCES music_submissions(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL,
  catalogue_version INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('queued','fetching_audio','converting','waiting_for_empty_server','installing','installed','failed')),
  reason TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);
