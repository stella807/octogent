PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('shipper', 'supplier')),
  contact_email       TEXT NOT NULL,
  contact_phone       TEXT NOT NULL,
  city                TEXT NOT NULL,
  region              TEXT NOT NULL,
  country             TEXT NOT NULL,
  postal_code         TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_notes  TEXT NOT NULL DEFAULT '',
  mc_number           TEXT NOT NULL DEFAULT '',
  dot_number          TEXT NOT NULL DEFAULT '',
  insurance_expires_at TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('shipper', 'supplier', 'admin')),
  company_id    TEXT REFERENCES companies(id),
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS supplier_profiles (
  company_id         TEXT PRIMARY KEY REFERENCES companies(id),
  equipment          TEXT NOT NULL DEFAULT '[]',
  cargo_types        TEXT NOT NULL DEFAULT '[]',
  service_regions    TEXT NOT NULL DEFAULT '[]',
  lanes              TEXT NOT NULL DEFAULT '[]',
  capabilities       TEXT NOT NULL DEFAULT '[]',
  blackout_dates     TEXT NOT NULL DEFAULT '[]',
  max_weight_lbs     INTEGER NOT NULL DEFAULT 0,
  rate_per_mile_cents INTEGER,
  notes              TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_stats (
  company_id             TEXT PRIMARY KEY REFERENCES companies(id),
  completed_shipments    INTEGER NOT NULL DEFAULT 0,
  on_time_deliveries     INTEGER NOT NULL DEFAULT 0,
  late_deliveries        INTEGER NOT NULL DEFAULT 0,
  cancellations          INTEGER NOT NULL DEFAULT 0,
  opportunities_seen     INTEGER NOT NULL DEFAULT 0,
  quotes_submitted       INTEGER NOT NULL DEFAULT 0,
  response_seconds_total INTEGER NOT NULL DEFAULT 0,
  responses_counted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shipments (
  id                   TEXT PRIMARY KEY,
  reference            TEXT NOT NULL UNIQUE,
  shipper_company_id   TEXT NOT NULL REFERENCES companies(id),
  origin_city          TEXT NOT NULL,
  origin_region        TEXT NOT NULL,
  origin_country       TEXT NOT NULL,
  origin_postal_code   TEXT,
  dest_city            TEXT NOT NULL,
  dest_region          TEXT NOT NULL,
  dest_country         TEXT NOT NULL,
  dest_postal_code     TEXT,
  pickup_from          TEXT NOT NULL,
  pickup_to            TEXT NOT NULL,
  deliver_by           TEXT,
  cargo_type           TEXT NOT NULL,
  cargo_description    TEXT NOT NULL,
  pallet_count         INTEGER NOT NULL DEFAULT 0,
  weight_lbs           INTEGER NOT NULL,
  length_in            INTEGER,
  width_in             INTEGER,
  height_in            INTEGER,
  equipment            TEXT NOT NULL,
  special_requirements TEXT NOT NULL DEFAULT '[]',
  target_price_cents   INTEGER,
  visibility           TEXT NOT NULL DEFAULT 'marketplace',
  status               TEXT NOT NULL DEFAULT 'posted',
  awarded_quote_id     TEXT,
  created_at           TEXT NOT NULL,
  closed_at            TEXT
);
CREATE INDEX IF NOT EXISTS shipments_shipper ON shipments(shipper_company_id);
CREATE INDEX IF NOT EXISTS shipments_status ON shipments(status);

CREATE TABLE IF NOT EXISTS shipment_invitations (
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  company_id  TEXT NOT NULL REFERENCES companies(id),
  PRIMARY KEY (shipment_id, company_id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id                  TEXT PRIMARY KEY,
  shipment_id         TEXT NOT NULL REFERENCES shipments(id),
  supplier_company_id TEXT NOT NULL REFERENCES companies(id),
  status              TEXT NOT NULL DEFAULT 'pending',
  price_cents         INTEGER NOT NULL,
  transit_days        INTEGER NOT NULL,
  equipment           TEXT NOT NULL,
  terms               TEXT NOT NULL DEFAULT '',
  valid_until         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (shipment_id, supplier_company_id)
);
CREATE INDEX IF NOT EXISTS quotes_supplier ON quotes(supplier_company_id);

CREATE TABLE IF NOT EXISTS quote_offers (
  id           TEXT PRIMARY KEY,
  quote_id     TEXT NOT NULL REFERENCES quotes(id),
  actor        TEXT NOT NULL CHECK (actor IN ('supplier', 'shipper')),
  price_cents  INTEGER NOT NULL,
  transit_days INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quote_offers_quote ON quote_offers(quote_id);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  shipment_id         TEXT NOT NULL REFERENCES shipments(id),
  supplier_company_id TEXT NOT NULL REFERENCES companies(id),
  sender_user_id      TEXT NOT NULL REFERENCES users(id),
  sender_company_id   TEXT NOT NULL REFERENCES companies(id),
  body                TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(shipment_id, supplier_company_id);

CREATE TABLE IF NOT EXISTS shipment_events (
  id             TEXT PRIMARY KEY,
  shipment_id    TEXT NOT NULL REFERENCES shipments(id),
  type           TEXT NOT NULL,
  actor_user_id  TEXT REFERENCES users(id),
  detail         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shipment_events_shipment ON shipment_events(shipment_id);
