require('dotenv').config();
// Allow disabling TLS verification for local dev (Docker on macOS)
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, init } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Website Scraper ───────────────────────────────────────────────────────────

const SCRAPE_TIMEOUT_MS = 12000;

const INDUSTRY_KEYWORDS = {
  Solar:         ['solar', 'photovoltaik', 'solaranlage', 'pv-anlage', 'énergie solaire'],
  Sanitär:       ['sanitär', 'sanitaer', 'heizung', 'klima', 'plomberie'],
  Gastronomie:   ['restaurant', 'café', 'bistro', 'gastronomie', 'küche', 'catering'],
  Elektro:       ['elektro', 'elektriker', 'elektroinstallation', 'elektrotechnik'],
  Bau:           ['bau', 'bauunternehmen', 'renovierung', 'umbau', 'maler', 'zimmerei'],
  Immobilien:    ['immobilien', 'liegenschaft', 'wohnungen', 'miete', 'verkauf'],
  Fitness:       ['fitness', 'gym', 'yoga', 'sport', 'training', 'physiotherapie'],
  Handel:        ['shop', 'store', 'kaufen', 'onlineshop', 'boutique'],
  Dienstleistung:['beratung', 'consulting', 'dienstleistung', 'treuhand', 'fiduciaire'],
  Coiffeur:      ['coiffeur', 'friseur', 'hairstudio', 'barbershop'],
  Autogewerbe:   ['autogarage', 'garage', 'automobile', 'fahrzeug', 'kfz'],
};

async function scrapeWebsite(rawUrl) {
  let url = rawUrl.trim();
  if (!url.startsWith('http')) url = 'https://' + url;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DLMScraper/1.0)' },
      redirect: 'follow',
    });
    const html = await resp.text();
    const lower = html.toLowerCase();
    const finalUrl = resp.url || url;

    // Company name: og:site_name > <title> first segment
    const ogSite  = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1]
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
    const rawTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    const company_name = (ogSite || rawTitle.split(/[|\-–•·]/)[0]).trim().slice(0, 100);

    // Phone — Swiss patterns
    const phoneMatch = lower.match(/(?:\+41|0041|0\d{1,2})\s?(?:\d[\s\-\.]?){6,9}\d/);
    const phone = phoneMatch ? phoneMatch[0].replace(/\s{2,}/g, ' ').trim().slice(0, 25) : '';

    // Email
    const emailMatch = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0].toLowerCase() : '';

    // Industry detection
    let industry = '';
    for (const [ind, kws] of Object.entries(INDUSTRY_KEYWORDS)) {
      if (kws.some(kw => lower.includes(kw))) { industry = ind; break; }
    }

    // Lead score (higher = more gaps = more DLM potential)
    let lead_score = 0;
    if (!lower.includes('width=device-width'))                          lead_score += 20;
    if (!lower.match(/rechner|konfigurator|calculator|kalkulator/))     lead_score += 20;
    if (!lower.match(/googletagmanager|adsbygoogle|googletag\.cmd/))    lead_score += 15;
    if (!lower.match(/impressum/))                                       lead_score += 5;
    if (lower.match(/bootstrap\/[23]\.|jquery\/1\.|<font |<center>/))   lead_score += 15;
    if (!finalUrl.startsWith('https'))                                   lead_score += 10;
    lead_score = Math.min(100, lead_score);

    return { company_name, website_url: finalUrl, phone, email, industry, lead_score };
  } finally {
    clearTimeout(tid);
  }
}

// In-memory job store
const scrapeJobs = new Map();

app.post('/api/leads/scrape-preview', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const data = await scrapeWebsite(url);
    res.json(data);
  } catch (err) {
    res.status(422).json({ error: err.message || 'Scraping failed' });
  }
});

app.post('/api/leads/scrape', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array required' });
  }
  const jobId = uuidv4();
  const job = { id: jobId, total: urls.length, done: 0, failed: 0, results: [], status: 'running' };
  scrapeJobs.set(jobId, job);

  (async () => {
    for (const rawUrl of urls) {
      try {
        const data = await scrapeWebsite(rawUrl);
        const id  = uuidv4();
        const now = new Date().toISOString();
        const hostname = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://'+rawUrl).hostname;
        db.prepare(`
          INSERT OR IGNORE INTO leads (id, company_name, website_url, phone, email, industry, lead_score, source, status, created_at)
          VALUES (?,?,?,?,?,?,?,'manual','new',?)
        `).run(id, data.company_name || hostname, data.website_url, data.phone || null,
               data.email || null, data.industry || null, data.lead_score, now);
        job.results.push({ url: rawUrl, leadId: id, ...data, ok: true });
      } catch (err) {
        job.failed++;
        job.results.push({ url: rawUrl, ok: false, error: err.message?.slice(0, 120) || 'error' });
      }
      job.done++;
    }
    job.status = 'done';
  })();

  res.json({ jobId, total: urls.length });
});

app.get('/api/leads/scrape/status/:jobId', (req, res) => {
  const job = scrapeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Design Scoring & Screenshot ───────────────────────────────────────────────

const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const INDUSTRY_LEAD_SCORES = {
  Sanitär: 20, Elektro: 20, Bau: 20, Fitness: 20, Immobilien: 20, Solar: 20,
  Gastronomie: 15, Dienstleistung: 15, Coiffeur: 15, Autogewerbe: 15,
  Handel: 10, Sonstiges: 5,
};

async function analyzeWebsite(rawUrl) {
  let url = rawUrl.trim();
  if (!url.startsWith('http')) url = 'https://' + url;

  const breakdown = {};
  let design_score = 0;
  let screenshotData = null;
  let pagespeedOk = false;

  // ── PageSpeed Insights (free tier) ───────────────────────────────────────
  try {
    const apiKey = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
    const psUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile${apiKey}`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 30000);
    const psRes = await fetch(psUrl, { signal: ctrl.signal });
    clearTimeout(tid);

    if (psRes.ok) {
      const ps = await psRes.json();
      pagespeedOk = true;

      screenshotData = ps.lighthouseResult?.audits?.['final-screenshot']?.details?.data || null;

      const perf = ps.lighthouseResult?.categories?.performance?.score ?? -1;
      if (perf >= 0) {
        const pct = Math.round(perf * 100);
        if (perf < 0.50)      { design_score += 25; breakdown.performance = `Sehr langsam (${pct}/100) +25`; }
        else if (perf < 0.75) { design_score += 15; breakdown.performance = `Langsam (${pct}/100) +15`; }
        else if (perf < 0.90) { design_score += 5;  breakdown.performance = `Mittel (${pct}/100) +5`; }
        else                   { breakdown.performance = `Schnell (${pct}/100) +0`; }
      }

      const viewport = ps.lighthouseResult?.audits?.viewport;
      if (viewport?.score === 0) { design_score += 20; breakdown.mobile = 'Nicht mobile-optimiert +20'; }
      else                        { breakdown.mobile = 'Mobile-optimiert +0'; }

      const a11y = ps.lighthouseResult?.categories?.accessibility?.score ?? -1;
      if (a11y >= 0 && a11y < 0.60) { design_score += 5; breakdown.a11y = `Schlechte Zugänglichkeit (${Math.round(a11y*100)}/100) +5`; }
    }
  } catch (_) {
    breakdown.pagespeed = 'PageSpeed API nicht verfügbar (Fallback)';
  }

  // ── HTML scrape for additional signals ────────────────────────────────────
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DLMScraper/1.0)' },
      redirect: 'follow',
    });
    clearTimeout(tid);
    const html = await resp.text();
    const lower = html.toLowerCase();
    const finalUrl = resp.url || url;

    if (!finalUrl.startsWith('https')) { design_score += 20; breakdown.ssl = 'Kein SSL/HTTPS +20'; }
    else { breakdown.ssl = 'SSL vorhanden +0'; }

    if (!pagespeedOk && !lower.includes('width=device-width')) {
      design_score += 20; breakdown.mobile = 'Kein Viewport-Meta (nicht mobil) +20';
    }

    const hasCTA = lower.match(/jetzt\s+buchen|termin\s+vereinbaren|angebot\s+anfragen|jetzt\s+anfragen|jetzt\s+bestellen|kontaktformular/);
    if (!hasCTA) { design_score += 15; breakdown.cta = 'Kein klarer CTA gefunden +15'; }
    else { breakdown.cta = 'CTA vorhanden +0'; }

    if (lower.match(/bootstrap\/[23]\.|jquery\/1\.|<font\s|<center>/)) {
      design_score += 10; breakdown.tech = 'Veraltete Technologie (Bootstrap 2/3, jQuery 1.x) +10';
    }

    const yearMatch = lower.match(/©.*?(20\d{2})|copyright.*?(20\d{2})/);
    const yr = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : 0;
    if (yr && yr < 2020) { design_score += 10; breakdown.age = `Letztes Copyright-Jahr: ${yr} +10`; }

    if (!lower.match(/googletagmanager|adsbygoogle|googletag\.cmd|gtag\(/)) {
      design_score += 5; breakdown.ads = 'Kein Google Tracking/Ads erkannt +5';
    } else { breakdown.ads = 'Google Tracking/Ads vorhanden +0'; }

  } catch (e) {
    breakdown.htmlScrape = `HTML-Analyse fehlgeschlagen: ${e.message?.slice(0, 60)}`;
  }

  design_score = Math.min(100, design_score);
  return { design_score, screenshotData, breakdown };
}

function computeLeadScore(lead, design_score) {
  let score = 0;
  score += Math.round(design_score * 0.25);   // Website quality (0–25)
  score += 20;                                  // Google Ads default (assume none)
  score += INDUSTRY_LEAD_SCORES[lead.industry] || 5;  // Industry (0–20)
  score += 10;                                  // Company size default (small)
  score += 10;                                  // Location default (CH)
  return Math.min(100, score);
}

app.post('/api/leads/:id/score', async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if (!lead.website_url) return res.status(400).json({ error: 'Lead has no website URL' });

  try {
    const { design_score, screenshotData, breakdown } = await analyzeWebsite(lead.website_url);

    let screenshot_url = lead.screenshot_url || null;
    if (screenshotData) {
      const imgPath = path.join(SCREENSHOTS_DIR, `${lead.id}.jpg`);
      const base64 = screenshotData.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
      screenshot_url = `/screenshots/${lead.id}.jpg`;
    }

    const lead_score = computeLeadScore(lead, design_score);

    db.prepare(`UPDATE leads SET design_score=?, lead_score=?, screenshot_url=?, score_breakdown=? WHERE id=?`)
      .run(design_score, lead_score, screenshot_url, JSON.stringify(breakdown), lead.id);

    res.json({ design_score, lead_score, screenshot_url, breakdown });
  } catch (err) {
    console.error('Score error:', err);
    res.status(500).json({ error: err.message || 'Analyse fehlgeschlagen' });
  }
});

// ── Opportunities ─────────────────────────────────────────────────────────────

app.get('/api/opportunities', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM appointments a WHERE a.opportunity_id = o.id) AS appointment_count
    FROM opportunities o
    ORDER BY o.updated_at DESC
  `).all();
  res.json(rows);
});

app.get('/api/opportunities/:id', (req, res) => {
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  const appointments = db.prepare('SELECT * FROM appointments WHERE opportunity_id = ? ORDER BY date ASC').all(req.params.id);
  const notes = db.prepare('SELECT * FROM notes WHERE opportunity_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...opp, appointments, notes });
});

app.post('/api/opportunities', (req, res) => {
  const { company_name, contact_name, contact_email, contact_phone, status, value_chf, notes, source } = req.body;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO opportunities (id, company_name, contact_name, contact_email, contact_phone, status, value_chf, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, company_name, contact_name || null, contact_email || null, contact_phone || null,
         status || 'contact', value_chf || 0, source || null, now, now);
  if (notes) {
    db.prepare('INSERT INTO notes (id, opportunity_id, body, created_at) VALUES (?,?,?,?)')
      .run(uuidv4(), id, notes, now);
  }
  res.json({ id });
});

app.patch('/api/opportunities/:id', (req, res) => {
  const opp = db.prepare('SELECT id FROM opportunities WHERE id = ?').get(req.params.id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  const fields = ['company_name', 'contact_name', 'contact_email', 'contact_phone', 'status', 'value_chf', 'source'];
  const updates = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  updates.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(req.params.id);
  db.prepare(`UPDATE opportunities SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.delete('/api/opportunities/:id', (req, res) => {
  db.prepare('DELETE FROM appointments WHERE opportunity_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notes WHERE opportunity_id = ?').run(req.params.id);
  db.prepare('DELETE FROM opportunities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Notes ─────────────────────────────────────────────────────────────────────

app.post('/api/opportunities/:id/notes', (req, res) => {
  const { body } = req.body;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO notes (id, opportunity_id, body, created_at) VALUES (?,?,?,?)').run(id, req.params.id, body, now);
  db.prepare('UPDATE opportunities SET updated_at = ? WHERE id = ?').run(now, req.params.id);
  res.json({ id });
});

// ── Appointments ──────────────────────────────────────────────────────────────

app.get('/api/appointments', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, o.company_name, o.contact_name FROM appointments a
    LEFT JOIN opportunities o ON o.id = a.opportunity_id
    ORDER BY a.date ASC
  `).all();
  res.json(rows);
});

app.post('/api/appointments', (req, res) => {
  const { opportunity_id, title, date, duration_min, location, notes } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO appointments (id, opportunity_id, title, date, duration_min, location, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, opportunity_id, title, date, duration_min || 60, location || null, notes || null, new Date().toISOString());
  res.json({ id });
});

app.delete('/api/appointments/:id', (req, res) => {
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Pipeline / Dashboard ──────────────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  const pipeline = db.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(value_chf), 0) AS total_value
    FROM opportunities GROUP BY status
  `).all();

  const total  = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(value_chf),0) AS v FROM opportunities').get();
  const won    = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(value_chf),0) AS v FROM opportunities WHERE status='won'").get();
  const lost   = db.prepare("SELECT COUNT(*) AS c FROM opportunities WHERE status='lost'").get();
  const active = db.prepare("SELECT COUNT(*) AS c FROM opportunities WHERE status NOT IN ('won','lost')").get();

  const upcoming = db.prepare(`
    SELECT a.*, o.company_name FROM appointments a
    LEFT JOIN opportunities o ON o.id = a.opportunity_id
    WHERE a.date >= datetime('now')
    ORDER BY a.date ASC LIMIT 5
  `).all();

  const recentActivity = db.prepare('SELECT * FROM opportunities ORDER BY updated_at DESC LIMIT 10').all();

  const conversionRate = total.c > 0 ? Math.round((won.c / total.c) * 100) : 0;
  const forecast = db.prepare(`
    SELECT COALESCE(SUM(value_chf * CASE status
      WHEN 'contact' THEN 0.1
      WHEN 'demo' THEN 0.3
      WHEN 'offer' THEN 0.6
      WHEN 'negotiation' THEN 0.8
      ELSE 0
    END), 0) AS value
    FROM opportunities WHERE status NOT IN ('won','lost')
  `).get();

  res.json({
    pipeline,
    stats: {
      total: total.c, totalValue: total.v,
      won: won.c, wonValue: won.v,
      lost: lost.c, active: active.c,
      conversionRate, forecast: Math.round(forecast.value)
    },
    upcoming,
    recentActivity
  });
});

// ── Email Logs ────────────────────────────────────────────────────────────────

function insertEmailLog(opportunityId, entry) {
  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO email_logs
      (id, opportunity_id, direction, from_addr, to_addr, subject, body_snippet, campaign_id, resend_id, sent_at, received_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, opportunityId || null, entry.direction || 'outbound',
         entry.from || null, entry.to || null, entry.subject || '(no subject)',
         entry.bodySnippet || null, entry.campaignId || null, entry.resendId || null,
         entry.sentAt || null, entry.receivedAt || null, now);
  if (opportunityId) {
    db.prepare('UPDATE opportunities SET updated_at = ? WHERE id = ?').run(now, opportunityId);
  }
  return id;
}

app.post(['/api/leads/:id/emails', '/api/opportunities/:id/emails'], (req, res) => {
  const oppId = req.params.id === 'inbox' ? null : req.params.id;
  if (oppId) {
    const opp = db.prepare('SELECT id FROM opportunities WHERE id = ?').get(oppId);
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
  }
  const id = insertEmailLog(oppId, req.body);
  res.status(201).json({ id });
});

app.get(['/api/leads/:id/emails', '/api/opportunities/:id/emails'], (req, res) => {
  const rows = db.prepare('SELECT * FROM email_logs WHERE opportunity_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

app.get('/api/email-logs', (req, res) => {
  const { direction, limit = 50 } = req.query;
  let q = 'SELECT el.*, o.company_name FROM email_logs el LEFT JOIN opportunities o ON o.id = el.opportunity_id';
  const params = [];
  if (direction) { q += ' WHERE el.direction = ?'; params.push(direction); }
  q += ` ORDER BY el.created_at DESC LIMIT ?`;
  params.push(parseInt(limit, 10));
  const rows = db.prepare(q).all(...params);
  res.json(rows);
});

app.patch('/api/email-logs/by-resend/:resendId/status', (req, res) => {
  const { status } = req.body;
  if (!['sent', 'opened', 'clicked', 'bounced', 'spam'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE email_logs SET status = ? WHERE resend_id = ?').run(status, req.params.resendId);
  res.json({ ok: true });
});

app.patch('/api/email-logs/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['sent', 'opened', 'clicked', 'bounced', 'spam'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const result = db.prepare('UPDATE email_logs SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Leads ─────────────────────────────────────────────────────────────────────

app.get('/api/leads', (req, res) => {
  const { status, industry, q } = req.query;
  let query = 'SELECT * FROM leads';
  const conditions = [];
  const vals = [];
  if (status)   { conditions.push('status = ?');   vals.push(status); }
  if (industry) { conditions.push('industry = ?'); vals.push(industry); }
  if (q) {
    conditions.push('(company_name LIKE ? OR contact_name LIKE ? OR email LIKE ?)');
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...vals);
  // Parse score_breakdown JSON
  res.json(rows.map(r => ({ ...r, score_breakdown: r.score_breakdown ? JSON.parse(r.score_breakdown) : null })));
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json({ ...lead, score_breakdown: lead.score_breakdown ? JSON.parse(lead.score_breakdown) : null });
});

app.post('/api/leads', (req, res) => {
  const { company_name, website_url, contact_name, phone, email, industry, status, lead_score, design_score, source, notes, last_contact_at } = req.body;
  if (!company_name) return res.status(400).json({ error: 'company_name required' });
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO leads (id, company_name, website_url, contact_name, phone, email, industry, status, lead_score, design_score, source, notes, created_at, last_contact_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, company_name, website_url || null, contact_name || null, phone || null, email || null,
         industry || null, status || 'new', lead_score || 0, design_score || 0,
         source || 'manual', notes || null, now, last_contact_at || null);
  res.status(201).json({ id });
});

app.patch('/api/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const fields = ['company_name', 'website_url', 'contact_name', 'phone', 'email', 'industry',
                  'status', 'lead_score', 'design_score', 'source', 'notes', 'last_contact_at', 'screenshot_url'];
  const updates = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Catch-all → SPA ──────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

init();
app.listen(PORT, () => console.log(`CRM running on http://localhost:${PORT}`));
