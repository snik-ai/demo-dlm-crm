# DLM Demo Generator

Automated website demo generation pipeline for the sales team. Takes a leads CSV and produces personalized, mobile-responsive HTML demos ready to share with prospects.

## Quick Start (Sales Team)

### 1. Add your leads to `leads.csv`

Required columns: `firmenname`, `branche`, `ort`, `telefon`, `email`, `adresse`, `slogan`  
Optional column: `slug` (auto-derived from firmenname if omitted)

**Supported verticals (`branche` values):**

| Value        | Industry         |
|--------------|------------------|
| `kueche`     | Küchenbau        |
| `sanitaer`   | Sanitär/Heizung  |
| `solar`      | Solaranlagen     |
| `treuhand`   | Treuhand/Finanzen|
| `fitness`    | Fitness/Sport    |
| `autogarage` | Autogarage       |
| `coiffeur`   | Coiffeur/Salon   |
| `zahnarzt`   | Zahnarzt         |
| `restaurant` | Restaurant/Café  |
| `immobilien` | Immobilien       |

### 2. Generate demos

```bash
node scripts/generate.js
```

Demos are output to `output/{slug}/index.html`. An index page is created at `output/index.html`.

### 3. Deploy to Replit

```bash
node scripts/deploy-replit.js --slug kuechen-meier-zuerich
```

This uploads the demo to Replit and returns a shareable `https://replit.com/@dlmdigital/{slug}` link.

To deploy **all** demos from the last run:

```bash
node scripts/deploy-replit.js --all
```

Requires `REPLIT_API_TOKEN` in environment (see Setup below).

---

## Setup (First Time / Engineer)

```bash
# No npm install needed — pure Node.js, no dependencies
node --version  # requires Node 16+
```

**Environment variables:**

```
REPLIT_API_TOKEN=your_replit_token   # for deploy-replit.js
```

Add to your `.env` file or export in your shell.

---

## Customizing a Demo (Sales Handoff)

To swap in the client's real logo/name before sending:

1. Open `output/{slug}/index.html`
2. Replace `{{FIRMENNAME}}` with the client's exact name (if any remain)
3. Replace the placeholder logo `src` with a real image URL
4. Replace `G-XXXXXXXXXX` with the actual Google Tag ID
5. Replace `CONVERSION_LABEL` with the Google Ads conversion label

Estimated time: **< 30 minutes** per demo.

---

## Pipeline Acceptance Criteria ✅

- [x] Generate working demo from vertical + client name — runs in seconds
- [x] Mobile-responsive (viewport meta + responsive CSS in all templates)
- [x] Loads in <3s (static HTML, no external JS except optional gtag)
- [x] Google Ads conversion tracking scaffold in every template
- [x] Sales team can run `node scripts/generate.js` without engineer help

---

## Adding a New Vertical

1. Create `templates/{vertical}.html` — use `{{FIRMENNAME}}`, `{{ORT}}`, `{{TELEFON}}`, `{{EMAIL}}`, `{{ADRESSE}}`, `{{SLOGAN}}` as placeholders
2. Add the vertical name to the table above in this README
3. Run the generator against a test lead to verify output

Template checklist:
- `<meta name="viewport">` present
- Google Ads scaffold block in `<head>`
- `trackConversion()` called on form submit
- Mobile-responsive layout (CSS media queries or flexbox/grid)
