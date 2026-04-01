#!/usr/bin/env node
/**
 * DLM Digital — Inbound Email Poller
 *
 * Polls sales@dlm-digital.ch via IMAP every 5 minutes.
 * For each new reply:
 *   1. Logs the email to the CRM lead record
 *   2. Creates a Paperclip task assigned to Chief of Sales
 *   3. Marks message as seen
 *
 * ENV:
 *   IMAP_HOST           — e.g. mail.infomaniak.com
 *   IMAP_PORT           — default 993
 *   IMAP_USER           — sales@dlm-digital.ch
 *   IMAP_PASS           — mailbox password
 *   CRM_URL             — e.g. http://crm:3002
 *   CRM_SECRET          — bearer token for CRM API
 *   PAPERCLIP_API_URL   — e.g. http://host.docker.internal:3100
 *   PAPERCLIP_API_KEY   — short-lived JWT or service key
 *   PAPERCLIP_COMPANY_ID
 *   PAPERCLIP_GOAL_ID   — goal to attach reply tasks to
 *   CHIEF_OF_SALES_AGENT_ID — agent ID to assign reply tasks to
 *   POLL_INTERVAL_MIN   — default 5
 *   SEEN_FILE           — path to seen-UIDs JSON (default /app/data/seen.json)
 */

'use strict';

const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const cron            = require('node-cron');
const fs              = require('fs');
const path            = require('path');
const https           = require('https');
const http            = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const IMAP_HOST     = process.env.IMAP_HOST     || 'mail.infomaniak.com';
const IMAP_PORT     = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER     = process.env.IMAP_USER     || 'sales@dlm-digital.ch';
const IMAP_PASS     = process.env.IMAP_PASS     || '';

const CRM_URL       = process.env.CRM_URL       || 'http://crm:3002';
const CRM_SECRET    = process.env.CRM_SECRET    || process.env.ADMIN_SECRET || '';

const PC_API_URL    = process.env.PAPERCLIP_API_URL    || 'http://host.docker.internal:3100';
const PC_API_KEY    = process.env.PAPERCLIP_API_KEY    || '';
const PC_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || '';
const PC_GOAL_ID    = process.env.PAPERCLIP_GOAL_ID    || '';
const CHIEF_AGENT   = process.env.CHIEF_OF_SALES_AGENT_ID || '';

const POLL_MIN      = parseInt(process.env.POLL_INTERVAL_MIN || '5', 10);
const SEEN_FILE     = process.env.SEEN_FILE
  ? process.env.SEEN_FILE
  : path.join(__dirname, '..', '..', 'data', 'email-infra-seen.json');

// ── Seen-UIDs store ───────────────────────────────────────────────────────────
function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(set) {
  const dir = path.dirname(SEEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]), 'utf8');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function jsonRequest(method, rawUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(rawUrl);
    const lib  = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers:  {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const req = lib.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── CRM: log email to lead record ─────────────────────────────────────────────
async function logToCrm(leadId, entry) {
  if (!leadId) {
    console.warn('[crm] no leadId — logging to global inbox only');
    return;
  }
  try {
    const res = await jsonRequest(
      'POST',
      `${CRM_URL}/api/leads/${leadId}/emails`,
      entry,
      CRM_SECRET ? { Authorization: `Bearer ${CRM_SECRET}` } : {},
    );
    if (res.status >= 400) {
      console.warn(`[crm] log failed (${res.status}):`, res.body);
    }
  } catch (err) {
    console.warn('[crm] log error:', err.message);
  }
}

// ── Paperclip: create reply task for Chief of Sales ───────────────────────────
async function createPaperclipTask(reply) {
  if (!PC_API_KEY || !PC_COMPANY_ID) {
    console.warn('[paperclip] API not configured — skipping task creation');
    return;
  }
  const snippet = (reply.text || reply.html || '').slice(0, 300).replace(/\n+/g, ' ');
  const title   = `Reply from ${reply.fromName || reply.from} — ${reply.company || reply.subject}`;
  const body    = {
    title,
    description: [
      `**Von:** ${reply.fromName ? `${reply.fromName} <${reply.from}>` : reply.from}`,
      `**Firma:** ${reply.company || '—'}`,
      `**Betreff:** ${reply.subject}`,
      `**Nachricht:**\n\n> ${snippet}${snippet.length >= 300 ? '…' : ''}`,
      reply.crmLeadId ? `\n**CRM Lead:** [${reply.crmLeadId}](${CRM_URL}/leads/${reply.crmLeadId})` : '',
    ].filter(Boolean).join('\n'),
    status:       'todo',
    priority:     'high',
    goalId:       PC_GOAL_ID || undefined,
    ...(CHIEF_AGENT ? { assigneeAgentId: CHIEF_AGENT } : {}),
  };

  try {
    const res = await jsonRequest(
      'POST',
      `${PC_API_URL}/api/companies/${PC_COMPANY_ID}/issues`,
      body,
      { Authorization: `Bearer ${PC_API_KEY}` },
    );
    if (res.status === 201) {
      console.log(`[paperclip] task created: ${res.body.identifier} — ${title}`);
    } else {
      console.warn(`[paperclip] task creation failed (${res.status}):`, res.body);
    }
  } catch (err) {
    console.warn('[paperclip] error creating task:', err.message);
  }
}

// ── Match reply to CRM lead by campaign tag or domain ────────────────────────
function extractCampaignMeta(parsed) {
  // Resend stores campaign + lead info in custom headers when we send
  // X-DLM-Lead-Id, X-DLM-Company — we set these at send time
  return {
    leadId:   parsed.headers?.get('x-dlm-lead-id')  || null,
    company:  parsed.headers?.get('x-dlm-company')  || null,
    campaign: parsed.headers?.get('x-dlm-campaign') || null,
  };
}

// ── Core poll loop ────────────────────────────────────────────────────────────
async function pollInbox() {
  console.log(`[poll] connecting to ${IMAP_HOST}:${IMAP_PORT} as ${IMAP_USER}`);
  const seen   = loadSeen();
  const client = new ImapFlow({
    host:   IMAP_HOST,
    port:   IMAP_PORT,
    secure: true,
    auth:   { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      console.log(`[poll] mailbox: ${status.messages} total, ${status.unseen} unseen`);

      // Fetch unseen messages
      for await (const msg of client.fetch('1:*', {
        uid:      true,
        flags:    true,
        source:   true,
        envelope: true,
      })) {
        const uid = msg.uid.toString();
        if (seen.has(uid)) continue;
        if (msg.flags.has('\\Seen')) { seen.add(uid); continue; }

        // Parse the raw message
        const parsed = await simpleParser(msg.source);
        const from   = parsed.from?.value?.[0];
        if (!from) { seen.add(uid); continue; }

        // Skip bounces / auto-replies from our own domain
        const fromAddr = from.address?.toLowerCase() || '';
        if (
          fromAddr.includes('mailer-daemon') ||
          fromAddr.includes('postmaster') ||
          fromAddr.includes('noreply') ||
          fromAddr.includes('no-reply') ||
          fromAddr.endsWith('@dlm-digital.ch')
        ) {
          seen.add(uid);
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
          continue;
        }

        const meta = extractCampaignMeta(parsed);
        const reply = {
          uid,
          from:       fromAddr,
          fromName:   from.name || '',
          subject:    parsed.subject || '',
          text:       parsed.text || '',
          html:       parsed.html || '',
          receivedAt: new Date().toISOString(),
          crmLeadId:  meta.leadId,
          company:    meta.company || parsed.from?.value?.[0]?.name || '',
          campaign:   meta.campaign,
        };

        console.log(`[poll] new reply from ${fromAddr} — "${reply.subject}"`);

        // 1. Log to CRM
        await logToCrm(reply.crmLeadId, {
          direction: 'inbound',
          from:      fromAddr,
          fromName:  reply.fromName,
          subject:   reply.subject,
          bodySnippet: (reply.text || reply.html || '').slice(0, 500),
          receivedAt: reply.receivedAt,
        });

        // 2. Create Paperclip task for Chief of Sales
        await createPaperclipTask(reply);

        // 3. Mark as seen
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        seen.add(uid);
      }

      saveSeen(seen);
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('[poll] error:', err.message);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
if (!IMAP_PASS) {
  console.error('IMAP_PASS not set — exiting');
  process.exit(1);
}

console.log(`[email-infra] starting — poll every ${POLL_MIN} min`);

// Run immediately on start
pollInbox().catch(console.error);

// Then schedule
const cronExpr = `*/${POLL_MIN} * * * *`;
cron.schedule(cronExpr, () => pollInbox().catch(console.error));

console.log(`[email-infra] cron scheduled: ${cronExpr}`);
