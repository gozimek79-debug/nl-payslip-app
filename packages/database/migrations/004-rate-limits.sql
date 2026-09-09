CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0
);
