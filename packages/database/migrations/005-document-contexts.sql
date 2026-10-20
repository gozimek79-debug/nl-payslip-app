-- R3-B.2: short-lived, session-bound document records (apps/backend-node/src/document-context/store.ts).
-- Only extracted document facts and the profile/knowledge resolved from them; never a PDF, page image or text layer.
-- Rows expire after two hours and are deleted on the next write. The store also creates this table on first use.
CREATE TABLE IF NOT EXISTS document_contexts (
  ref text PRIMARY KEY,
  session_hash text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_contexts_expires_at ON document_contexts (expires_at);
