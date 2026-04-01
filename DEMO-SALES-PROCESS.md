# DLM Digital — Demo Delivery Process

**SLA: Demo delivered within 4 hours of request (target: <1 hour for standard verticals)**

---

## 1. Demo Request — Sales Team Intake

When a prospect asks for a demo, fill out this request template and send to `marc@dlm-digital.ch` or the shared sales Slack channel:

```
DEMO REQUEST
============
Firmenname:     [exact name as it should appear]
Branche:        [kueche | sanitaer | solar | treuhand | fitness | autogarage | coiffeur | zahnarzt | restaurant | immobilien]
Ort:            [city]
Telefon:        [phone number]
E-Mail:         [company email]
Adresse:        [street address]
Slogan:         [short tagline, e.g. "Ihre Experten seit 1985"]
Logo URL:       [direct link to logo, or "none"]
Primärfarbe:    [hex code, e.g. #1a4f9c, or "default"]
Priorität:      [normal | dringend]
Notizen:        [anything special]
```

---

## 2. Engineer — Demo Generation (< 30 min)

1. Add the lead as a new row in `demo-generator/leads.csv`
2. Run the generator:
   ```bash
   node demo-generator/scripts/generate.js
   ```
3. Preview the output at `demo-generator/output/{slug}/index.html`
4. If the request includes a custom color: find/replace the primary color CSS variable in the output file
5. Deploy to Replit:
   ```bash
   node demo-generator/scripts/deploy-replit.js --slug {slug}
   ```
6. Send the Replit URL to the sales rep

**Standard turnaround: < 1 hour for any existing vertical**

---

## 3. Delivery — What Sales Sends to the Prospect

```
Betreff: Ihre persönliche Website-Demo — [Firmenname]

Liebe/r [Vorname],

ich habe eine Demo-Version Ihrer neuen Website vorbereitet:

👉 [Replit-Link]

Die Demo zeigt wie Ihre Seite aussehen könnte — mit Ihrem Firmenname, 
Telefon und Ihrem Slogan. Mobile-optimiert, schnell, und bereit für 
Google Ads.

In einem 20-Minuten-Gespräch zeige ich Ihnen wie wir die Seite 
live bringen und wie wir gemeinsam Leads über Google Ads generieren.

Passt es Ihnen diese oder nächste Woche?

Freundliche Grüsse,
Marc
DLM Digital AG
```

---

## 4. Sales Customization Guide (< 30 min)

If the engineer is unavailable, the sales team can customize a demo directly:

### Step 1 — Open the file
Open `demo-generator/output/{slug}/index.html` in any text editor (VS Code recommended).

### Step 2 — Replace placeholder values
Use Find & Replace (Ctrl+H / Cmd+H):

| Find | Replace with |
|------|-------------|
| `G-XXXXXXXXXX` | Client's Google Tag ID (from their Google Ads account) |
| `CONVERSION_LABEL` | Conversion label from Google Ads |

### Step 3 — Swap the logo
Find the `<img` tag with `alt="Logo"` and update the `src` attribute to point to the client's logo URL.

### Step 4 — Adjust primary color (optional)
Find `:root {` near the top of the CSS. Change the `--primary` or `--blue` color variable to match the client's brand.

### Step 5 — Deploy
Drag the folder to Replit, or ask the engineer to run `deploy-replit.js`.

**Estimated time: 20–30 minutes**

---

## 5. SLA Summary

| Situation | Turnaround |
|-----------|-----------|
| Standard vertical (existing template) | < 1 hour |
| New color / logo swap | + 15 min |
| New vertical (no template yet) | < 4 hours |
| Engineer unavailable (sales self-serve) | < 30 min |

---

## 6. Escalation Path

If the engineer is unavailable and the request is urgent:

1. Use the self-serve customization guide above (Step 4)
2. Use an existing similar demo and rename it manually
3. For new verticals with no template: contact `marc@dlm-digital.ch` — engineer responds within 2 hours during business hours

---

## 7. After the Demo — Conversion Tracking Setup

Once a prospect becomes a client:

1. Replace `G-XXXXXXXXXX` with their actual Google Tag Manager ID
2. Set up a Google Ads conversion action and replace `CONVERSION_LABEL`
3. Point their domain to the demo (or rebuild on their CMS)
4. Hand off to onboarding

---

*Last updated: 2026-04-01 | Owner: Founding Engineer*
