CREATE TABLE IF NOT EXISTS exam_records (
  type TEXT NOT NULL CHECK (type IN ('users', 'assignments', 'submissions')),
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (type, id)
);

CREATE TABLE IF NOT EXISTS exam_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS exam_sessions_expiry ON exam_sessions(expires_at);

CREATE TABLE IF NOT EXISTS exam_rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  started INTEGER NOT NULL
);

