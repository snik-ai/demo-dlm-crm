#!/usr/bin/env node
/**
 * DLM Digital – Demo Generator
 * Reads leads.csv → outputs personalized HTML demos to /output/{slug}/index.html
 *
 * Usage:
 *   node scripts/generate.js [--leads path/to/leads.csv] [--out path/to/output]
 *
 * CSV columns (required): firmenname, branche, ort, telefon, email, adresse, slogan
 * CSV columns (optional): slug (auto-derived from firmenname if missing)
 *
 * Branche values (maps to template):
 *   kueche | sanitaer | solar | treuhand | fitness | autogarage | coiffeur | zahnarzt | restaurant | immobilien
 */

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_OUT  = path.join(__dirname, '..', 'output');
const DEFAULT_CSV  = path.join(__dirname, '..', 'leads.csv');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const leadsPath = getArg('--leads') || DEFAULT_CSV;
const outputDir = getArg('--out')   || DEFAULT_OUT;

// ── Helpers ───────────────────────────────────────────────────────────────────
function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Minimal CSV parser — handles quoted fields with commas */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = splitCSVLine(line);
      const row = {};
      headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
      return row;
    });
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(cur); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur);
  return result;
}

/** Replace {{PLACEHOLDER}} tokens in template HTML */
function applyVariables(html, vars) {
  return html.replace(/\{\{([A-Z_]+?)(?:\|([^}]*))?\}\}/g, (match, key, fallback) => {
    const val = vars[key.toLowerCase()];
    if (val && val.trim()) return val;
    if (fallback !== undefined) return fallback;
    return match; // leave unreplaced if no value and no fallback
  });
}

// ── Template cache ────────────────────────────────────────────────────────────
const templateCache = {};
function loadTemplate(branche) {
  const key = branche.toLowerCase().trim();
  if (!templateCache[key]) {
    const filePath = path.join(TEMPLATE_DIR, `${key}.html`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Template not found for branche "${branche}": ${filePath}`);
    }
    templateCache[key] = fs.readFileSync(filePath, 'utf8');
  }
  return templateCache[key];
}

// ── Main ──────────────────────────────────────────────────────────────────────
function generate() {
  if (!fs.existsSync(leadsPath)) {
    console.error(`❌  Leads file not found: ${leadsPath}`);
    console.error('   Create leads.csv or pass --leads path/to/file.csv');
    process.exit(1);
  }

  const csvText = fs.readFileSync(leadsPath, 'utf8');
  const leads   = parseCSV(csvText);

  console.log(`\n📋  Loaded ${leads.length} leads from ${path.basename(leadsPath)}`);
  console.log(`📁  Output dir: ${outputDir}\n`);

  const results = [];
  let ok = 0, fail = 0;

  for (const lead of leads) {
    const { firmenname, branche, ort, telefon, email, adresse, slogan } = lead;
    const slug = lead.slug || slugify(firmenname);

    if (!firmenname || !branche) {
      console.warn(`⚠️   Skipping row — missing firmenname or branche: ${JSON.stringify(lead)}`);
      fail++;
      continue;
    }

    try {
      const template = loadTemplate(branche);
      const vars = { firmenname, ort, telefon, email, adresse, slogan };
      const html  = applyVariables(template, vars);

      const dir = path.join(outputDir, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');

      results.push({ slug, firmenname, branche, ort, url: `demo.dlm-digital.ch/${slug}` });
      console.log(`  ✅  ${firmenname.padEnd(35)} → /${slug}`);
      ok++;
    } catch (err) {
      console.error(`  ❌  ${firmenname}: ${err.message}`);
      fail++;
    }
  }

  // Write manifest
  const manifest = {
    generated: new Date().toISOString(),
    total: leads.length,
    success: ok,
    failed: fail,
    demos: results,
  };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Write demo index page
  writeIndexPage(outputDir, results);

  console.log(`\n🎉  Done — ${ok} demos generated, ${fail} failed`);
  console.log(`📄  Manifest: ${path.join(outputDir, 'manifest.json')}`);
  console.log(`🌐  Index:    ${path.join(outputDir, 'index.html')}\n`);
}

function writeIndexPage(outputDir, demos) {
  const rows = demos.map(d => `
    <tr>
      <td><a href="${d.slug}/index.html" target="_blank">${d.firmenname}</a></td>
      <td>${d.branche}</td>
      <td>${d.ort}</td>
      <td><code>${d.url}</code></td>
      <td><a href="${d.slug}/index.html" target="_blank" class="btn">Öffnen →</a></td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>DLM Demo Library</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 3rem auto; padding: 0 1.5rem; color: #1a1a2e; }
    h1 { font-size: 1.8rem; margin-bottom: .5rem; }
    .meta { color: #666; font-size: .9rem; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th { text-align: left; padding: .6rem .8rem; background: #f0f0f5; font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; }
    td { padding: .65rem .8rem; border-bottom: 1px solid #e8e8f0; }
    tr:hover td { background: #fafafe; }
    a { color: #4a5fd8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .btn { display: inline-block; padding: .3rem .7rem; background: #4a5fd8; color: white; border-radius: 4px; font-size: .82rem; }
    .btn:hover { background: #3348c0; text-decoration: none; }
    code { font-size: .82rem; background: #f0f0f5; padding: .15rem .35rem; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>DLM Demo Library</h1>
  <p class="meta">Generated: ${new Date().toLocaleString('de-CH')} · ${demos.length} demos</p>
  <table>
    <thead><tr><th>Firma</th><th>Branche</th><th>Ort</th><th>Demo-URL</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
  fs.writeFileSync(path.join(outputDir, 'index.html'), html, 'utf8');
}

generate();
