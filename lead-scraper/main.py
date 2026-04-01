"""
DLM Digital — Lead Scraper & Website Scorer
Usage: python main.py [--max-leads 500] [--min-score 70] [--workers 5]

No API key required — uses Playwright to scrape Google Maps directly.
Setup: pip install playwright && playwright install chromium

Output: leads_scored.csv (all), leads_qualified.csv (score >= min-score), leads_top100.csv
"""

import os
import csv
import logging
import argparse
import concurrent.futures
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

from scraper import scrape_leads
from scorer import score_website

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

FIELDNAMES = [
    "name", "address", "website", "phone", "rating", "reviews",
    "keyword", "canton",
    "score", "ssl", "load_time_ms", "mobile_optimized", "has_impressum",
    "has_google_ads", "has_configurator", "modern_design", "reasons", "error",
    "top100",
]


def score_lead(lead: dict) -> dict:
    website = lead.get("website", "")
    if not website:
        lead.update({"score": 0, "reasons": "no website", "error": "no_website",
                     "ssl": False, "load_time_ms": 0, "mobile_optimized": False,
                     "has_impressum": False, "has_google_ads": False,
                     "has_configurator": False, "modern_design": False, "top100": False})
        return lead

    result = score_website(website)
    scored = result.to_dict()
    lead.update({
        "score": scored["score"],
        "ssl": scored["ssl"],
        "load_time_ms": scored["load_time_ms"],
        "mobile_optimized": scored["mobile_optimized"],
        "has_impressum": scored["has_impressum"],
        "has_google_ads": scored["has_google_ads"],
        "has_configurator": scored["has_configurator"],
        "modern_design": scored["modern_design"],
        "reasons": scored["reasons"],
        "error": scored["error"],
        "top100": False,
    })
    return lead


def write_csv(rows: list[dict], path: Path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    logger.info(f"Wrote {len(rows)} rows → {path}")


def main():
    parser = argparse.ArgumentParser(description="DLM Lead Scraper")
    parser.add_argument("--max-leads", type=int, default=600,
                        help="Max leads to scrape before scoring (default 600)")
    parser.add_argument("--min-score", type=int, default=70,
                        help="Minimum DLM score to include in qualified list (default 70)")
    parser.add_argument("--workers", type=int, default=5,
                        help="Parallel scorer workers (default 5)")
    parser.add_argument("--output-dir", type=str, default="output",
                        help="Output directory (default: ./output)")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # --- Step 1: Scrape ---
    logger.info(f"Starting scrape (max {args.max_leads} leads with website)...")
    raw_leads = []
    for lead in scrape_leads():
        raw_leads.append(lead)
        if len(raw_leads) % 50 == 0:
            logger.info(f"  Scraped {len(raw_leads)} leads so far...")
        if len(raw_leads) >= args.max_leads:
            break

    logger.info(f"Scrape complete: {len(raw_leads)} leads with websites")

    # --- Step 2: Score in parallel ---
    logger.info(f"Scoring websites with {args.workers} workers...")
    scored_leads = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(score_lead, lead): lead for lead in raw_leads}
        done = 0
        for future in concurrent.futures.as_completed(futures):
            scored_leads.append(future.result())
            done += 1
            if done % 25 == 0:
                logger.info(f"  Scored {done}/{len(raw_leads)}...")

    # Sort by score descending
    scored_leads.sort(key=lambda x: x.get("score", 0), reverse=True)

    # Mark top 100
    for i, lead in enumerate(scored_leads):
        lead["top100"] = (i < 100)

    # --- Step 3: Write outputs ---
    all_path = output_dir / f"leads_all_{timestamp}.csv"
    write_csv(scored_leads, all_path)

    qualified = [l for l in scored_leads if l.get("score", 0) >= args.min_score]
    qualified_path = output_dir / f"leads_qualified_{timestamp}.csv"
    write_csv(qualified, qualified_path)

    top100 = scored_leads[:100]
    top100_path = output_dir / f"leads_top100_{timestamp}.csv"
    write_csv(top100, top100_path)

    # --- Summary ---
    avg_score = sum(l.get("score", 0) for l in scored_leads) / max(len(scored_leads), 1)
    print("\n" + "="*60)
    print(f"DLM Lead Scraper — Run complete ({timestamp})")
    print("="*60)
    print(f"  Total leads scraped:     {len(raw_leads)}")
    print(f"  Scored successfully:     {len(scored_leads)}")
    print(f"  Qualified (≥{args.min_score} score):  {len(qualified)}")
    print(f"  Average score:           {avg_score:.1f}")
    print(f"  Top 100 for CEO review:  {len(top100)}")
    print(f"\nFiles written to ./{args.output_dir}/")
    print(f"  All leads:   {all_path.name}")
    print(f"  Qualified:   {qualified_path.name}")
    print(f"  Top 100:     {top100_path.name}")
    print("="*60)


if __name__ == "__main__":
    main()
