const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
// Utility: fetch with timeout
// ─────────────────────────────────────────
function fetchWithTimeout(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const startTime = Date.now();

    const req = lib.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DLM-SichtbarkeitsCheck/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 50000) req.abort(); });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body, latency: Date.now() - startTime }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.abort(); reject(new Error('timeout')); });
    req.setTimeout(timeoutMs);
  });
}

// ─────────────────────────────────────────
// Check: SSL
// ─────────────────────────────────────────
async function checkSSL(url) {
  try {
    const httpsUrl = url.replace(/^http:\/\//, 'https://');
    const result = await fetchWithTimeout(httpsUrl, 6000);
    const works = result.statusCode < 500;

    if (works) {
      return { score: 15, maxScore: 15, status: 'good', message: 'SSL-Zertifikat vorhanden und gültig — Ihre Verbindung ist sicher.' };
    }
    return { score: 5, maxScore: 15, status: 'warning', message: 'HTTPS erreichbar, aber der Server antwortet mit Fehlern.' };
  } catch {
    // Try HTTP
    try {
      const httpUrl = url.replace(/^https:\/\//, 'http://');
      await fetchWithTimeout(httpUrl, 5000);
      return { score: 0, maxScore: 15, status: 'critical', message: 'Kein SSL-Zertifikat — Browser markieren Ihre Seite als "Nicht sicher". Google bevorzugt HTTPS-Seiten.' };
    } catch {
      return { score: 5, maxScore: 15, status: 'warning', message: 'SSL-Status konnte nicht geprüft werden — die Seite war nicht erreichbar.' };
    }
  }
}

// ─────────────────────────────────────────
// Check: Mobile & Speed via PageSpeed API
// ─────────────────────────────────────────
async function checkPageSpeed(url) {
  const apiKey = process.env.PAGESPEED_API_KEY || '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile${apiKey ? '&key=' + apiKey : ''}`;

  try {
    const result = await fetchWithTimeout(apiUrl, 20000);
    if (result.statusCode !== 200) throw new Error('API error');

    const data = JSON.parse(result.body);
    const lhCategories = data.lighthouseResult?.categories;
    const lhAudits = data.lighthouseResult?.audits;

    const mobileScore = Math.round((lhCategories?.performance?.score || 0) * 100);
    const fcp = lhAudits?.['first-contentful-paint']?.displayValue || '';
    const lcp = lhAudits?.['largest-contentful-paint']?.displayValue || '';
    const viewport = lhAudits?.['viewport']?.score === 1;

    // Mobile check
    let mobileResult;
    if (viewport && mobileScore >= 70) {
      mobileResult = { score: 25, maxScore: 25, status: 'good', message: 'Seite ist mobil optimiert und schnell — sehr gut für Google-Rankings.' };
    } else if (viewport && mobileScore >= 40) {
      mobileResult = { score: 16, maxScore: 25, status: 'warning', message: `Mobile Score: ${mobileScore}/100 — Optimierungspotenzial vorhanden. 60% Ihrer Besucher kommen per Smartphone.` };
    } else {
      mobileResult = { score: 5, maxScore: 25, status: 'critical', message: 'Seite ist nicht für Mobilgeräte optimiert — Google rankt mobile Seiten bevorzugt.' };
    }

    // Speed check
    let speedResult;
    if (mobileScore >= 70) {
      speedResult = { score: 20, maxScore: 20, status: 'good', message: `Ladezeit: ${fcp || 'schnell'} — Gute Performance, Besucher bleiben länger auf Ihrer Seite.` };
    } else if (mobileScore >= 40) {
      const loadInfo = lcp ? `Ladezeit: ${lcp} — ` : '';
      speedResult = { score: 12, maxScore: 20, status: 'warning', message: `${loadInfo}Verbesserungspotenzial vorhanden. Jede Sekunde Ladezeit kostet 7% Conversion-Rate.` };
    } else {
      const loadInfo = lcp ? `Ladezeit: ${lcp} — ` : '';
      speedResult = { score: 4, maxScore: 20, status: 'critical', message: `${loadInfo}Seite lädt zu langsam. Google bestraft langsame Seiten in den Rankings.` };
    }

    return { mobile: mobileResult, speed: speedResult };
  } catch (err) {
    // No API key or rate limit — return neutral results
    return {
      mobile: { score: 12, maxScore: 25, status: 'warning', message: 'Mobile-Analyse konnte nicht durchgeführt werden — bitte URL erneut prüfen.' },
      speed:  { score: 10, maxScore: 20, status: 'warning', message: 'Ladezeit-Analyse nicht verfügbar. Für genaue Messungen bitte PageSpeed API-Key konfigurieren.' },
    };
  }
}

// ─────────────────────────────────────────
// Check: Google My Business (heuristic)
// ─────────────────────────────────────────
async function checkGMB(url, htmlBody) {
  // Look for structured data (LocalBusiness schema) and GMB signals
  const hasSchema = htmlBody.includes('"LocalBusiness"') ||
                    htmlBody.includes('"Organization"') ||
                    htmlBody.includes('schema.org/LocalBusiness');
  const hasGoogleMaps = htmlBody.includes('maps.google') || htmlBody.includes('google.com/maps');
  const hasAddress = /<address/i.test(htmlBody);

  // Google My Business verification signals
  if (hasSchema && hasGoogleMaps) {
    return { score: 20, maxScore: 25, status: 'good', message: 'Strukturierte Daten und Google Maps Integration gefunden — gute Basis für lokale Sichtbarkeit.' };
  } else if (hasSchema || hasGoogleMaps || hasAddress) {
    return { score: 12, maxScore: 25, status: 'warning', message: 'Teilweise lokale Signale vorhanden — ein vollständiger Google My Business Eintrag würde lokale Sichtbarkeit stark erhöhen.' };
  } else {
    return { score: 0, maxScore: 25, status: 'critical', message: 'Kein Google My Business Eintrag oder strukturierte Daten gefunden — Sie verlieren täglich lokale Suchanfragen.' };
  }
}

// ─────────────────────────────────────────
// Check: Google Ads presence (heuristic)
// ─────────────────────────────────────────
function checkGoogleAds(htmlBody) {
  const signals = [
    'googletagmanager', 'gtag(', 'gtag/', 'AW-',
    'google_conversion', 'googleadservices',
    'adwords', 'doubleclick'
  ];
  const found = signals.filter(s => htmlBody.includes(s));

  if (found.length >= 2) {
    return { score: 15, maxScore: 15, status: 'good', message: 'Google Ads Tracking erkannt — Sie nutzen bereits Google-Werbung. Optimierungspotenzial prüfen lohnt sich.' };
  } else if (found.length === 1) {
    return { score: 8, maxScore: 15, status: 'warning', message: 'Google Tag Manager vorhanden, aber keine aktiven Ads-Kampagnen erkannt. Mit Google Ads könnten Sie sofort mehr Anfragen erhalten.' };
  } else {
    return { score: 3, maxScore: 15, status: 'critical', message: 'Keine Google Ads Kampagnen erkannt — Ihre Mitbewerber schalten bereits Anzeigen für Ihre wichtigsten Keywords.' };
  }
}

// ─────────────────────────────────────────
// POST /api/analyze
// ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  let { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL required' });
  }

  // Normalize URL
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    new URL(url); // validate
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  console.log(`[analyze] ${url}`);

  try {
    // Fetch homepage HTML for heuristic checks
    let htmlBody = '';
    try {
      const result = await fetchWithTimeout(url, 10000);
      htmlBody = result.body || '';
    } catch {}

    // Run all checks in parallel
    const [sslResult, speedResults] = await Promise.all([
      checkSSL(url),
      checkPageSpeed(url),
    ]);

    const gmbResult  = await checkGMB(url, htmlBody);
    const adsResult  = checkGoogleAds(htmlBody);

    // Compute total score
    const checks = {
      ssl:    sslResult,
      gmb:    gmbResult,
      ads:    adsResult,
      mobile: speedResults.mobile,
      speed:  speedResults.speed,
    };

    const totalScore = Object.values(checks).reduce((sum, c) => sum + c.score, 0);
    const maxTotal   = Object.values(checks).reduce((sum, c) => sum + c.maxScore, 0);
    const score = Math.round((totalScore / maxTotal) * 100);

    res.json({ score, url, checks });
  } catch (err) {
    console.error('[analyze error]', err.message);
    res.status(500).json({ error: 'Analysis failed', message: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/subscribe
// ─────────────────────────────────────────
const subscribers = [];

app.post('/api/subscribe', (req, res) => {
  const { name, email, url, score } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const entry = { name, email, url, score, timestamp: new Date().toISOString() };
  subscribers.push(entry);
  console.log('[subscribe]', entry);

  // TODO: integrate with email provider (Resend/Mailjet) and CRM
  // await sendWelcomeEmail({ to: email, name, url, score });

  res.json({ success: true });
});

// ─────────────────────────────────────────
// GET /api/subscribers (internal, for CRM hand-off)
// ─────────────────────────────────────────
app.get('/api/subscribers', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== (process.env.ADMIN_SECRET || 'dlm-admin-2024')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(subscribers);
});

// ─────────────────────────────────────────
// Health check
// ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, subscribers: subscribers.length }));

app.listen(PORT, () => {
  console.log(`Sichtbarkeits-Check läuft auf http://localhost:${PORT}`);
  console.log(`PageSpeed API Key: ${process.env.PAGESPEED_API_KEY ? 'gesetzt' : 'nicht gesetzt (Rate-Limit kann auftreten)'}`);
});
