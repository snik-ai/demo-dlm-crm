#!/usr/bin/env node
/**
 * DLM Digital — Email Queue Builder
 * Reads leads_with_emails.csv + demo output manifest.json
 * Generates personalised HTML emails and POSTs them to the CEO dashboard queue.
 *
 * Usage:
 *   node mailing/queue-emails.js \
 *     --leads ../lead-scraper/output/leads_qualified_YYYYMMDD.csv \
 *     --demos ../demo-generator/output/manifest.json \
 *     --dashboard http://localhost:3001 \
 *     --secret $ADMIN_SECRET
 *
 * The script builds one email per lead (if a matching demo slug exists).
 * CEO must approve each email in the dashboard before it is sent.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };

const LEADS_CSV   = getArg('--leads')     || '../lead-scraper/output/leads_with_emails.csv';
const DEMO_JSON   = getArg('--demos')     || '../demo-generator/output/manifest.json';
const DASHBOARD   = getArg('--dashboard') || 'http://localhost:3001';
const SECRET      = getArg('--secret')    || process.env.ADMIN_SECRET || '';
const CAMPAIGN_ID = getArg('--campaign')  || `outreach-${new Date().toISOString().slice(0,10)}`;
const BASE_URL    = getArg('--base-url')  || 'https://demo.dlm-digital.ch';
const DRY_RUN     = args.includes('--dry');

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g,''));
  return lines.slice(1).filter(l=>l.trim()).map(line => {
    const vals = splitLine(line);
    const row = {};
    headers.forEach((h,i) => row[h] = (vals[i]||'').trim());
    return row;
  });
}

function splitLine(line) {
  const r=[]; let c='',q=false;
  for(const ch of line) {
    if(ch==='"'){q=!q;continue;}
    if(ch===','&&!q){r.push(c);c='';continue;}
    c+=ch;
  }
  r.push(c);
  return r;
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

function buildEmailHtml(lead, demoUrl) {
  const firstName = lead.first_name || lead.toname || 'Guten Tag';
  const company   = lead.name || lead.company || '';
  const ort       = lead.ort || lead.city || '';

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<style>
  body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#1f2937; line-height:1.6; margin:0; padding:0; background:#f9fafb; }
  .wrap { max-width:560px; margin:32px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 16px rgba(0,0,0,.08); }
  .header { background:#1a4f9c; padding:28px 32px; }
  .header h2 { color:#fff; margin:0; font-size:20px; font-weight:700; }
  .header p  { color:rgba(255,255,255,.7); margin:4px 0 0; font-size:14px; }
  .body { padding:28px 32px; }
  .body p { margin:0 0 16px; font-size:15px; }
  .cta { display:inline-block; background:#1a4f9c; color:#fff!important; text-decoration:none; padding:13px 28px; border-radius:8px; font-weight:700; font-size:15px; margin:8px 0 20px; }
  .demo-preview { border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; margin:16px 0; }
  .demo-preview img { width:100%; display:block; }
  .demo-url { font-size:12px; color:#6b7280; padding:8px 12px; background:#f9fafb; }
  .footer { border-top:1px solid #e5e7eb; padding:20px 32px; font-size:12px; color:#9ca3af; }
  .footer a { color:#6b7280; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h2>DLM Digital AG</h2>
    <p>Ihre neue Website — in 48 Stunden live</p>
  </div>
  <div class="body">
    <p>Guten Tag${firstName !== 'Guten Tag' ? ` ${firstName}` : ''},</p>
    <p>ich bin auf <strong>${company}</strong>${ort ? ` in ${ort}` : ''} gestossen und habe Ihnen eine individuelle Demo-Website erstellt — kostenlos, unverbindlich, in Ihrer Branche.</p>
    <p>Schauen Sie mal rein:</p>
    <a class="cta" href="${demoUrl}">Demo ansehen →</a>
    <div class="demo-preview">
      <div class="demo-url">${demoUrl}</div>
    </div>
    <p>Falls Sie Interesse haben oder Fragen: kurze Antwort auf diese Mail genügt. Ich rufe Sie auch gerne an.</p>
    <p>Freundliche Grüsse<br><strong>Marc Schmid</strong><br>DLM Digital AG · dlm-digital.ch</p>
  </div>
  <div class="footer">
    Sie erhalten diese E-Mail, weil wir Ihre Firma im Rahmen unserer Marktrecherche gefunden haben.<br>
    <a href="mailto:marc@dlm-digital.ch?subject=Abmelden">Abmelden</a>
  </div>
</div>
</body></html>`;
}

function buildEmailText(lead, demoUrl) {
  const firstName = lead.first_name || '';
  const company   = lead.name || lead.company || '';
  return `Guten Tag${firstName ? ` ${firstName}` : ''},

ich habe ${company} eine individuelle Demo-Website erstellt — kostenlos, unverbindlich.

Schauen Sie rein: ${demoUrl}

Bei Interesse oder Fragen: kurze Antwort genügt.

Freundliche Grüsse
Marc Schmid — DLM Digital AG
dlm-digital.ch

---
Abmelden: mailto:marc@dlm-digital.ch?subject=Abmelden`;
}

async function postToQueue(emails) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(emails);
    const url  = new URL(`${DASHBOARD}/api/emails`);
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(SECRET ? { Authorization: `Bearer ${SECRET}` } : {}),
      },
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load leads
  if (!fs.existsSync(LEADS_CSV)) {
    console.error(`Leads CSV not found: ${LEADS_CSV}`);
    process.exit(1);
  }
  const leads = parseCSV(fs.readFileSync(LEADS_CSV, 'utf8'));
  console.log(`Loaded ${leads.length} leads`);

  // Load demo manifest (slug → url mapping)
  let demoMap = {};
  if (fs.existsSync(DEMO_JSON)) {
    const manifest = JSON.parse(fs.readFileSync(DEMO_JSON, 'utf8'));
    for (const item of manifest) {
      demoMap[item.slug] = `${BASE_URL}/${item.slug}`;
    }
    console.log(`Loaded ${Object.keys(demoMap).length} demo slugs`);
  } else {
    console.warn(`No manifest.json found at ${DEMO_JSON} — will derive slug from company name`);
  }

  const emails = [];
  let skipped = 0;

  for (const lead of leads) {
    const email = lead.best_email || lead.email || '';
    if (!email || email.startsWith('info@') && !lead.best_email) {
      // Only skip if we have no personalised email AND fallback is info@
    }
    if (!email) { skipped++; continue; }

    const slug    = lead.slug || slugify(lead.name || lead.firmenname || '');
    const demoUrl = demoMap[slug] || `${BASE_URL}/${slug}`;

    const item = {
      to:         email,
      toName:     `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.name || '',
      company:    lead.name || lead.firmenname || '',
      subject:    `Ihre Demo-Website ist fertig — ${lead.name || 'Ihr Unternehmen'}`,
      bodyHtml:   buildEmailHtml(lead, demoUrl),
      bodyText:   buildEmailText(lead, demoUrl),
      demoUrl,
      campaignId: CAMPAIGN_ID,
    };
    emails.push(item);
  }

  console.log(`Built ${emails.length} emails (${skipped} skipped — no email)`);

  if (DRY_RUN) {
    console.log('\nDry run — first email preview:');
    console.log(JSON.stringify(emails[0], null, 2));
    return;
  }

  // POST to dashboard in batches of 50
  const BATCH = 50;
  let queued = 0;
  for (let i = 0; i < emails.length; i += BATCH) {
    const batch  = emails.slice(i, i + BATCH);
    const result = await postToQueue(batch);
    if (result.status !== 201) {
      console.error(`Batch ${i}-${i+BATCH} failed (${result.status}): ${result.body}`);
    } else {
      queued += batch.length;
      console.log(`Queued ${queued}/${emails.length}...`);
    }
  }

  console.log(`\nDone. ${queued} emails queued in CEO dashboard (${DASHBOARD})`);
  console.log('→ CEO muss nun jeden Mail im Dashboard genehmigen bevor er gesendet wird.');
}

main().catch(err => { console.error(err); process.exit(1); });
