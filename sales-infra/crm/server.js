/**
 * DLM Digital — CRM Opportunity Tracker
 * Express.js backend for pipeline, calendar, and forecasting
 *
 * ENV:
 *   PORT          — server port (default 3002)
 *   ADMIN_SECRET  — bearer token for board/CEO access
 *   CFO_SECRET    — read-only bearer token for CFO
 *   DATA_DIR      — persistent storage directory (default: __dirname)
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3002;
const DATA = process.env.DATA_DIR || __dirname;

const DB_OPP = path.join(DATA, 'opportunities.json');
const DB_APT = path.join(DATA, 'appointments.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(readOnly = false) {
  return (req, res, next) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const cfoSecret   = process.env.CFO_SECRET;
    if (!adminSecret) return next(); // dev mode

    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    if (auth === adminSecret) return next();
    if (readOnly && cfoSecret && auth === cfoSecret) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Pipeline stages in order
const STAGES = ['Kontakt', 'Demo', 'Angebot', 'Abschluss'];

// ── Opportunities ─────────────────────────────────────────────────────────────

/** GET /api/opportunities */
app.get('/api/opportunities', requireAuth(true), (req, res) => {
  let opps = load(DB_OPP);
  const { stage, status } = req.query;
  if (stage)  opps = opps.filter(o => o.stage === stage);
  if (status) opps = opps.filter(o => o.status === status);
  res.json(opps);
});

/** GET /api/opportunities/:id */
app.get('/api/opportunities/:id', requireAuth(true), (req, res) => {
  const opps = load(DB_OPP);
  const opp  = opps.find(o => o.id === req.params.id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  res.json(opp);
});

/** POST /api/opportunities — create */
app.post('/api/opportunities', requireAuth(), (req, res) => {
  const { company, contact, email, phone, stage, value, notes, source } = req.body;
  if (!company) return res.status(400).json({ error: 'company is required' });

  const opps = load(DB_OPP);
  const opp  = {
    id:          crypto.randomUUID(),
    company:     company,
    contact:     contact || '',
    email:       email   || '',
    phone:       phone   || '',
    stage:       STAGES.includes(stage) ? stage : 'Kontakt',
    value:       Number(value) || 0,
    notes:       notes  || '',
    source:      source || 'manual',
    status:      'open',   // open | won | lost
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    closedAt:    null,
    stageHistory: [{ stage: stage || 'Kontakt', movedAt: new Date().toISOString() }],
  };
  opps.push(opp);
  save(DB_OPP, opps);
  res.status(201).json(opp);
});

/** PATCH /api/opportunities/:id — update stage, status, notes, value */
app.patch('/api/opportunities/:id', requireAuth(), (req, res) => {
  const opps = load(DB_OPP);
  const idx  = opps.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const opp    = opps[idx];
  const fields = ['company', 'contact', 'email', 'phone', 'value', 'notes', 'source'];
  fields.forEach(f => { if (req.body[f] !== undefined) opp[f] = req.body[f]; });

  if (req.body.stage && STAGES.includes(req.body.stage) && req.body.stage !== opp.stage) {
    opp.stage = req.body.stage;
    opp.stageHistory.push({ stage: req.body.stage, movedAt: new Date().toISOString() });
  }

  if (req.body.status && ['open', 'won', 'lost'].includes(req.body.status)) {
    opp.status   = req.body.status;
    if (req.body.status !== 'open') opp.closedAt = new Date().toISOString();
  }

  opp.updatedAt = new Date().toISOString();
  opps[idx]     = opp;
  save(DB_OPP, opps);
  res.json(opp);
});

/** DELETE /api/opportunities/:id */
app.delete('/api/opportunities/:id', requireAuth(), (req, res) => {
  let opps = load(DB_OPP);
  opps     = opps.filter(o => o.id !== req.params.id);
  save(DB_OPP, opps);
  res.json({ ok: true });
});

// ── Appointments ──────────────────────────────────────────────────────────────

/** GET /api/appointments */
app.get('/api/appointments', requireAuth(true), (req, res) => {
  let apts = load(DB_APT);
  const { oppId, from, to } = req.query;
  if (oppId) apts = apts.filter(a => a.opportunityId === oppId);
  if (from)  apts = apts.filter(a => a.date >= from);
  if (to)    apts = apts.filter(a => a.date <= to);
  apts.sort((a, b) => a.date.localeCompare(b.date));
  res.json(apts);
});

/** POST /api/appointments — create */
app.post('/api/appointments', requireAuth(), (req, res) => {
  const { opportunityId, title, date, duration, location, notes } = req.body;
  if (!date || !title) return res.status(400).json({ error: 'date and title required' });

  const opps = load(DB_OPP);
  if (opportunityId && !opps.find(o => o.id === opportunityId)) {
    return res.status(400).json({ error: 'opportunity not found' });
  }

  const apts = load(DB_APT);
  const apt  = {
    id:             crypto.randomUUID(),
    opportunityId:  opportunityId || null,
    title:          title,
    date:           date,
    duration:       duration || 60,
    location:       location || '',
    notes:          notes   || '',
    status:         'scheduled', // scheduled | done | cancelled
    createdAt:      new Date().toISOString(),
  };
  apts.push(apt);
  save(DB_APT, apts);
  res.status(201).json(apt);
});

/** PATCH /api/appointments/:id */
app.patch('/api/appointments/:id', requireAuth(), (req, res) => {
  const apts = load(DB_APT);
  const idx  = apts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const apt = apts[idx];
  ['title', 'date', 'duration', 'location', 'notes', 'status'].forEach(f => {
    if (req.body[f] !== undefined) apt[f] = req.body[f];
  });
  apts[idx] = apt;
  save(DB_APT, apts);
  res.json(apt);
});

/** DELETE /api/appointments/:id */
app.delete('/api/appointments/:id', requireAuth(), (req, res) => {
  let apts = load(DB_APT);
  apts     = apts.filter(a => a.id !== req.params.id);
  save(DB_APT, apts);
  res.json({ ok: true });
});

// ── Dashboard & Forecast ──────────────────────────────────────────────────────

/** GET /api/stats — CEO/CFO dashboard stats */
app.get('/api/stats', requireAuth(true), (req, res) => {
  const opps = load(DB_OPP);
  const apts = load(DB_APT);
  const now  = new Date();

  const byStage = STAGES.reduce((acc, s) => {
    const stageOpps = opps.filter(o => o.stage === s && o.status === 'open');
    acc[s] = {
      count: stageOpps.length,
      value: stageOpps.reduce((sum, o) => sum + o.value, 0),
    };
    return acc;
  }, {});

  const won   = opps.filter(o => o.status === 'won');
  const lost  = opps.filter(o => o.status === 'lost');
  const open  = opps.filter(o => o.status === 'open');

  const thisMonth = opps.filter(o => {
    const d = new Date(o.closedAt || o.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  // Weighted pipeline forecast (stage conversion rates)
  const weights = { 'Kontakt': 0.1, 'Demo': 0.3, 'Angebot': 0.6, 'Abschluss': 0.9 };
  const forecast = open.reduce((sum, o) => sum + o.value * (weights[o.stage] || 0.1), 0);

  // Upcoming appointments (next 7 days)
  const in7 = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const upcoming = apts
    .filter(a => a.status === 'scheduled' && a.date >= now.toISOString().slice(0, 10) && a.date <= in7)
    .length;

  res.json({
    pipeline:    byStage,
    total:       { open: open.length, won: won.length, lost: lost.length },
    revenue:     { won: won.reduce((s, o) => s + o.value, 0), thisMonth: thisMonth.filter(o => o.status === 'won').reduce((s, o) => s + o.value, 0) },
    forecast:    Math.round(forecast),
    conversion:  won.length > 0 ? Math.round(won.length / (won.length + lost.length) * 100) : 0,
    upcoming:    upcoming,
  });
});

/** GET /api/pipeline — kanban-ready pipeline data */
app.get('/api/pipeline', requireAuth(true), (req, res) => {
  const opps = load(DB_OPP).filter(o => o.status === 'open');
  const cols  = STAGES.map(stage => ({
    stage,
    opportunities: opps
      .filter(o => o.stage === stage)
      .sort((a, b) => b.value - a.value),
  }));
  res.json(cols);
});

app.listen(PORT, () => {
  console.log(`DLM CRM running on port ${PORT}`);
});
