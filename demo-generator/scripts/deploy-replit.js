#!/usr/bin/env node
/**
 * DLM Digital – Replit Deployer
 * Uploads a generated demo to Replit and returns a shareable link.
 *
 * Usage:
 *   node scripts/deploy-replit.js --slug kuechen-meier-zuerich
 *   node scripts/deploy-replit.js --all
 *   node scripts/deploy-replit.js --leads path/to/leads.csv  (deploy all slugs in CSV)
 *
 * Requires: REPLIT_API_TOKEN env var
 *
 * Replit API docs: https://docs.replit.com/reference/replit-api
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const OUTPUT_DIR   = path.join(__dirname, '..', 'output');
const MANIFEST     = path.join(OUTPUT_DIR, 'manifest.json');
const REPLIT_TOKEN = process.env.REPLIT_API_TOKEN;
const REPLIT_USER  = process.env.REPLIT_USER || 'dlmdigital';

if (!REPLIT_TOKEN) {
  console.error('❌  REPLIT_API_TOKEN environment variable not set.');
  console.error('   export REPLIT_API_TOKEN=your_token_here');
  process.exit(1);
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const getArg   = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const deployAll = args.includes('--all');
const slug      = getArg('--slug');

// ── Replit API helpers ────────────────────────────────────────────────────────

/** Create a new Repl (HTML/CSS/JS type) */
function createRepl(title) {
  return apiRequest('POST', '/v1/repls', {
    title,
    language: 'html',
    isPrivate: false,
  });
}

/** Upload a file to an existing Repl */
function uploadFile(replId, filename, content) {
  return apiRequest('PUT', `/v1/repls/${replId}/files/${encodeURIComponent(filename)}`, {
    content,
  });
}

/** Low-level HTTPS request to api.replit.com */
function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.replit.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${REPLIT_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Deploy one slug ───────────────────────────────────────────────────────────
async function deploySlug(slugName) {
  const htmlPath = path.join(OUTPUT_DIR, slugName, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Demo not found: ${htmlPath} — run generate.js first`);
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const replTitle   = `dlm-demo-${slugName}`;

  process.stdout.write(`  ⬆️   Deploying ${slugName} ...`);

  const repl = await createRepl(replTitle);
  await uploadFile(repl.id, 'index.html', htmlContent);

  const url = `https://replit.com/@${REPLIT_USER}/${replTitle}`;
  console.log(` ✅  ${url}`);
  return { slug: slugName, url, replId: repl.id };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const slugs = [];

  if (slug) {
    slugs.push(slug);
  } else if (deployAll) {
    if (!fs.existsSync(MANIFEST)) {
      console.error(`❌  No manifest found at ${MANIFEST}. Run generate.js first.`);
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    slugs.push(...manifest.demos.map(d => d.slug));
  } else {
    console.error('Usage:');
    console.error('  node scripts/deploy-replit.js --slug <slug>');
    console.error('  node scripts/deploy-replit.js --all');
    process.exit(1);
  }

  console.log(`\n🚀  Deploying ${slugs.length} demo(s) to Replit...\n`);

  const results = [];
  let ok = 0, fail = 0;

  for (const s of slugs) {
    try {
      const result = await deploySlug(s);
      results.push(result);
      ok++;
    } catch (err) {
      console.error(`  ❌  ${s}: ${err.message}`);
      fail++;
    }
  }

  // Update manifest with Replit URLs
  if (fs.existsSync(MANIFEST)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const urlMap = Object.fromEntries(results.map(r => [r.slug, r.url]));
    manifest.demos = manifest.demos.map(d => ({
      ...d,
      replitUrl: urlMap[d.slug] || d.replitUrl || null,
    }));
    manifest.lastDeployed = new Date().toISOString();
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  }

  console.log(`\n🎉  Done — ${ok} deployed, ${fail} failed`);
  if (ok > 0) {
    console.log(`\n📋  Deployed URLs:`);
    results.forEach(r => console.log(`   ${r.slug.padEnd(40)} → ${r.url}`));
  }
  console.log();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
