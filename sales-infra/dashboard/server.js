/**
 * DLM Digital — CEO Approval Dashboard
 * Express.js backend for email approval workflow
 *
 * ENV:
 *   RESEND_API_KEY   — Resend.com API key
 *   FROM_EMAIL       — sender address (e.g. marc@dlm-digital.ch)
 *   PORT             — server port (default 3001)
 *   ADMIN_SECRET     — simple bearer token for basic auth (set in Coolify)
 */

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;
const DB   = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'emails.json')
  : path.join(__dirname, 'emails.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Minimal bearer auth ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next(); // no secret set = dev mode, allow all
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${secret}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── DB helpers (flat JSON file for MVP) ──────────────────────────────────────
function loadEmails() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return [];
  }
}

function saveEmails(emails) {
  fs.writeFileSync(DB, JSON.stringify(emails, null, 2), 'utf8');
}

// ── CRM helpers ───────────────────────────────────────────────────────────────
const https2 = require('https');
function crmRequest(method, path, body) {
  const crmUrl    = process.env.CRM_URL;
  const crmSecret = process.env.CRM_SECRET || process.env.ADMIN_SECRET || '';
  if (!crmUrl) return;
  const payload = body ? JSON.stringify(body) : null;
  const u    = new (require('url').URL)(crmUrl + path);
  const lib  = u.protocol === 'https:' ? https2 : require('http');
  const req  = lib.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname, method,
    headers: {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(crmSecret ? { Authorization: `Bearer ${crmSecret}` } : {}),
    },
  });
  req.on('error', err => console.warn('[crm] request error:', err.message));
  if (payload) req.write(payload);
  req.end();
}

function logToCrm(leadId, entry) {
  if (!leadId) return;
  crmRequest('POST', `/api/leads/${leadId}/emails`, entry);
}

function updateCrmEmailStatus(resendId, status) {
  if (!resendId) return;
  crmRequest('PATCH', `/api/email-logs/by-resend/${encodeURIComponent(resendId)}/status`, { status });
}

// ── Resend client ─────────────────────────────────────────────────────────────
async function sendViaResend(email) {
  const { Resend } = await import('resend');
  const resend     = new Resend(process.env.RESEND_API_KEY);
  const replyTo    = process.env.REPLY_TO_EMAIL || 'sales@dlm-digital.ch';
  const result     = await resend.emails.send({
    from:     process.env.FROM_EMAIL || 'Marc <marc@dlm-digital.ch>',
    to:       [email.to],
    replyTo,
    subject:  email.subject,
    html:     email.bodyHtml,
    text:     email.bodyText,
    tags:     [{ name: 'campaign', value: email.campaignId || 'outreach' }],
    headers:  {
      'X-DLM-Lead-Id':  email.crmLeadId  || '',
      'X-DLM-Company':  email.company    || '',
      'X-DLM-Campaign': email.campaignId || '',
    },
  });
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/emails — list all emails */
app.get('/api/emails', requireAuth, (req, res) => {
  const { status } = req.query;
  let emails = loadEmails();
  if (status) emails = emails.filter(e => e.status === status);
  res.json(emails);
});

/** GET /api/emails/:id — single email */
app.get('/api/emails/:id', requireAuth, (req, res) => {
  const emails = loadEmails();
  const email  = emails.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json(email);
});

/** POST /api/emails — import email(s) into queue */
app.post('/api/emails', requireAuth, (req, res) => {
  const emails  = loadEmails();
  const payload = Array.isArray(req.body) ? req.body : [req.body];
  const added   = [];

  for (const item of payload) {
    if (!item.to || !item.subject) {
      return res.status(400).json({ error: 'to and subject are required' });
    }
    const email = {
      id:          crypto.randomUUID(),
      to:          item.to,
      toName:      item.toName || '',
      company:     item.company || '',
      subject:     item.subject,
      bodyHtml:    item.bodyHtml || '',
      bodyText:    item.bodyText || '',
      demoUrl:     item.demoUrl || '',
      campaignId:  item.campaignId || 'outreach',
      crmLeadId:   item.crmLeadId  || null,
      status:      'pending',   // pending | approved | rejected | sent | bounced
      createdAt:   new Date().toISOString(),
      sentAt:      null,
      resendId:    null,
      editedBody:  null,
      note:        '',
    };
    emails.push(email);
    added.push(email);
  }

  saveEmails(emails);
  res.status(201).json(added);
});

/** PATCH /api/emails/:id — edit body, approve, reject */
app.patch('/api/emails/:id', requireAuth, async (req, res) => {
  const emails = loadEmails();
  const idx    = emails.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const email  = emails[idx];
  const action = req.body.action; // 'approve' | 'reject' | 'edit'

  if (action === 'edit') {
    if (req.body.bodyHtml) email.editedBody = req.body.bodyHtml;
    if (req.body.bodyText) email.bodyText   = req.body.bodyText;
    if (req.body.subject)  email.subject    = req.body.subject;
    if (req.body.note)     email.note       = req.body.note;
  }

  if (action === 'reject') {
    email.status = 'rejected';
    if (req.body.note) email.note = req.body.note;
  }

  if (action === 'approve') {
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'RESEND_API_KEY not configured' });
    }
    try {
      // Use edited body if available
      const sendEmail = {
        ...email,
        bodyHtml: email.editedBody || email.bodyHtml,
      };
      const result = await sendViaResend(sendEmail);
      email.status    = 'sent';
      email.sentAt    = new Date().toISOString();
      email.resendId  = result.data?.id || null;
      // Log outbound to CRM
      logToCrm(email.crmLeadId, {
        direction: 'outbound',
        to:        email.to,
        toName:    email.toName,
        subject:   email.subject,
        bodySnippet: (email.bodyText || '').slice(0, 500),
        sentAt:    email.sentAt,
        resendId:  email.resendId,
        campaignId: email.campaignId,
      });
    } catch (err) {
      return res.status(500).json({ error: `Send failed: ${err.message}` });
    }
  }

  emails[idx] = email;
  saveEmails(emails);
  res.json(email);
});

/** POST /api/webhook/resend — handle Resend delivery events */
app.post('/api/webhook/resend', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Bad payload' });
  }

  const { type, data } = event;
  const STATUS_MAP = {
    'email.opened':    'opened',
    'email.clicked':   'clicked',
    'email.bounced':   'bounced',
    'email.complained': 'spam',
  };
  const newStatus = STATUS_MAP[type];
  // data.email_id corresponds to the Resend message ID
  if (newStatus && data?.email_id) {
    const emails = loadEmails();
    const idx    = emails.findIndex(e => e.resendId === data.email_id);
    if (idx !== -1) {
      emails[idx].status = newStatus;
      saveEmails(emails);
    }
    // Sync status back to CRM by resend ID
    updateCrmEmailStatus(data.email_id, newStatus);
  }

  res.json({ ok: true });
});

/** GET /api/stats — dashboard summary */
app.get('/api/stats', requireAuth, (req, res) => {
  const emails  = loadEmails();
  const counts  = emails.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {});
  res.json({ total: emails.length, ...counts });
});

app.listen(PORT, () => {
  console.log(`DLM Dashboard running on port ${PORT}`);
});
