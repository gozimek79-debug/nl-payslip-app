CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  locale text NOT NULL DEFAULT 'pl',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  status text NOT NULL,
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'NL',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_rule_id uuid NOT NULL REFERENCES legal_rules(id) ON DELETE CASCADE,
  version integer NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  parameters jsonb NOT NULL,
  source_url text NOT NULL,
  published_at timestamptz,
  UNIQUE (legal_rule_id, version)
);

CREATE TABLE analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payslip_id uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  ruleset_version text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payslip_fields (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payslip_id uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  numeric_value numeric(14, 2) NOT NULL,
  confidence numeric(5, 2),
  corrected_by_user boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payslip_id, field_name)
);

CREATE TABLE user_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payslips_user_created_idx ON payslips (user_id, created_at DESC);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id, expires_at DESC);
CREATE INDEX legal_rule_versions_validity_idx ON legal_rule_versions (valid_from, valid_to);
CREATE INDEX user_events_user_created_idx ON user_events (user_id, created_at DESC);
CREATE INDEX payslip_fields_payslip_idx ON payslip_fields (payslip_id);
