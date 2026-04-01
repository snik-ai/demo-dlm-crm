const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'crm.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// PostgreSQL-compatible pool shim backed by SQLite
const pool = {
  query: (sql, params = []) => {
    const normalized = sql
      .replace(/\$(\d+)/g, '?')
      .replace(/::int/g, '')
      .replace(/::text/g, '')
      .replace(/ILIKE/gi, 'LIKE');
    const trimmed = normalized.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      const rows = db.prepare(normalized).all(...(params || []));
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    const result = db.prepare(normalized).run(...(params || []));
    return Promise.resolve({ rows: [], rowCount: result.changes });
  }
};

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id            TEXT PRIMARY KEY,
      company_name  TEXT NOT NULL,
      contact_name  TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      status        TEXT NOT NULL DEFAULT 'contact'
                    CHECK(status IN ('contact','demo','offer','negotiation','won','lost')),
      value_chf     REAL NOT NULL DEFAULT 0,
      source        TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id               TEXT PRIMARY KEY,
      opportunity_id   TEXT NOT NULL REFERENCES opportunities(id),
      title            TEXT NOT NULL,
      date             TEXT NOT NULL,
      duration_min     INTEGER NOT NULL DEFAULT 60,
      location         TEXT,
      notes            TEXT,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id               TEXT PRIMARY KEY,
      opportunity_id   TEXT NOT NULL REFERENCES opportunities(id),
      body             TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_logs (
      id               TEXT PRIMARY KEY,
      opportunity_id   TEXT REFERENCES opportunities(id),
      direction        TEXT NOT NULL DEFAULT 'outbound' CHECK(direction IN ('inbound','outbound')),
      from_addr        TEXT,
      to_addr          TEXT,
      subject          TEXT NOT NULL DEFAULT '(no subject)',
      body_snippet     TEXT,
      campaign_id      TEXT,
      resend_id        TEXT,
      sent_at          TEXT,
      received_at      TEXT,
      status           TEXT NOT NULL DEFAULT 'sent',
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leads (
      id               TEXT PRIMARY KEY,
      company_name     TEXT NOT NULL,
      website_url      TEXT,
      contact_name     TEXT,
      phone            TEXT,
      email            TEXT,
      industry         TEXT,
      status           TEXT NOT NULL DEFAULT 'new'
                       CHECK(status IN ('new','contacted','demo','offer','won','lost')),
      lead_score       INTEGER NOT NULL DEFAULT 0,
      design_score     INTEGER NOT NULL DEFAULT 0,
      source           TEXT NOT NULL DEFAULT 'manual'
                       CHECK(source IN ('google_maps','manual','ads','referral')),
      notes            TEXT,
      created_at       TEXT NOT NULL,
      last_contact_at  TEXT,
      screenshot_url   TEXT,
      score_breakdown  TEXT
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      subject          TEXT NOT NULL,
      from_name        TEXT NOT NULL DEFAULT 'DLM Digital',
      from_email       TEXT NOT NULL DEFAULT 'hello@dlm-digital.ch',
      reply_to         TEXT,
      body_html        TEXT NOT NULL DEFAULT '',
      body_text        TEXT,
      status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK(status IN ('draft','scheduled','sending','sent','paused')),
      daily_limit      INTEGER NOT NULL DEFAULT 250,
      sent_count       INTEGER NOT NULL DEFAULT 0,
      open_count       INTEGER NOT NULL DEFAULT 0,
      click_count      INTEGER NOT NULL DEFAULT 0,
      unsubscribe_count INTEGER NOT NULL DEFAULT 0,
      scheduled_at     TEXT,
      started_at       TEXT,
      completed_at     TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_contacts (
      id               TEXT PRIMARY KEY,
      campaign_id      TEXT NOT NULL REFERENCES campaigns(id),
      email            TEXT NOT NULL,
      first_name       TEXT,
      last_name        TEXT,
      company          TEXT,
      phone            TEXT,
      custom_data      TEXT,
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','sent','opened','clicked','bounced','unsubscribed','failed')),
      resend_id        TEXT,
      unsubscribe_token TEXT NOT NULL,
      sent_at          TEXT,
      opened_at        TEXT,
      clicked_at       TEXT,
      error_message    TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_email ON campaign_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_token ON campaign_contacts(unsubscribe_token);

    CREATE TABLE IF NOT EXISTS unsubscribes (
      id               TEXT PRIMARY KEY,
      email            TEXT NOT NULL UNIQUE,
      source           TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_unsubscribes_email ON unsubscribes(email);
  `);
  return Promise.resolve();
}

module.exports = { db, pool, init };
