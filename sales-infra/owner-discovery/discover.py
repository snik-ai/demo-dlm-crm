"""
DLM Digital — Owner Discovery Module
Finds owner name and email from a Swiss company website.

Steps:
  1. Fetch homepage, look for Impressum link
  2. Parse Impressum for owner/Inhaber name (DE patterns)
  3. Build personalised email candidates: vorname.nachname@domain.ch
  4. Optional MX-verify before returning

Usage:
  python discover.py --url https://example.ch
  python discover.py --csv leads_qualified.csv --out leads_with_emails.csv
"""

import re
import dns.resolver
import requests
import csv
import argparse
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional
from urllib.parse import urljoin, urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    )
}
TIMEOUT = 12

# German/Swiss impressum patterns for finding the owner name
# Tries to match "Inhaber: Max Muster" or "Geschäftsführer: Max Muster" etc.
OWNER_PATTERNS = [
    r"inhaber[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    r"inhaberin[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    r"gesch[äa]ftsf[üu]hrer[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    r"gesch[äa]ftsf[üu]hrerin[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    r"ceo[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    r"leitung[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    r"verantwortlich[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
    # fallback: first proper noun pair after "Firma:" or company name line
    r"kontakt[:\s]+([A-ZÜÄÖ][a-züäö\-]+\s+[A-ZÜÄÖ][a-züäö\-]+)",
]

# Impressum page link patterns
IMPRESSUM_LINK_PATTERNS = [
    r"impressum",
    r"rechtliche[\s-]?hinweise",
    r"legal[\s-]?notice",
    r"kontakt",
]


@dataclass
class OwnerResult:
    url: str
    domain: str = ""
    impressum_url: str = ""
    owner_name: str = ""
    first_name: str = ""
    last_name: str = ""
    email_candidates: list = field(default_factory=list)
    best_email: str = ""
    fallback_email: str = ""
    mx_verified: bool = False
    error: str = ""

    def to_dict(self):
        d = asdict(self)
        d["email_candidates"] = "|".join(d["email_candidates"])
        return d


def _fetch(url: str) -> Optional[str]:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        logger.debug(f"Fetch failed for {url}: {e}")
        return None


def _find_impressum_url(base_url: str, html: str) -> Optional[str]:
    """Find the Impressum page URL from homepage HTML."""
    from html.parser import HTMLParser

    class LinkParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.links = []
        def handle_starttag(self, tag, attrs):
            if tag == "a":
                attrs_dict = dict(attrs)
                href = attrs_dict.get("href", "")
                text = ""
                for k, v in attrs:
                    if k == "href":
                        href = v
                self.links.append(href)

    parser = LinkParser()
    parser.feed(html)

    for href in parser.links:
        for pattern in IMPRESSUM_LINK_PATTERNS:
            if re.search(pattern, href, re.IGNORECASE):
                return urljoin(base_url, href)
    return None


def _extract_owner(text: str) -> tuple[str, str, str]:
    """Extract owner name from impressum text. Returns (full_name, first, last)."""
    text_clean = re.sub(r"\s+", " ", text)
    for pattern in OWNER_PATTERNS:
        match = re.search(pattern, text_clean, re.IGNORECASE)
        if match:
            full = match.group(1).strip()
            parts = full.split()
            if len(parts) >= 2:
                return full, parts[0], " ".join(parts[1:])
    return "", "", ""


def _build_email_candidates(first: str, last: str, domain: str) -> list[str]:
    """Build email address variants for a given name and domain."""
    f = _normalize_name(first)
    l = _normalize_name(last)
    return [
        f"{f}.{l}@{domain}",
        f"{f[0]}.{l}@{domain}",
        f"{f}{l}@{domain}",
        f"{l}@{domain}",
        f"{f}@{domain}",
    ]


def _normalize_name(name: str) -> str:
    """Convert name to lowercase ASCII suitable for email."""
    name = name.lower()
    replacements = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "é": "e", "è": "e", "à": "a"}
    for k, v in replacements.items():
        name = name.replace(k, v)
    name = re.sub(r"[^a-z0-9]", "", name)
    return name


def _mx_verify(domain: str) -> bool:
    """Check if domain has MX records (doesn't verify individual address)."""
    try:
        answers = dns.resolver.resolve(domain, "MX", lifetime=5)
        return len(answers) > 0
    except Exception:
        return False


def discover(url: str, verify_mx: bool = True) -> OwnerResult:
    result = OwnerResult(url=url)

    parsed = urlparse(url if "://" in url else f"https://{url}")
    result.domain = parsed.hostname or url.split("/")[0]
    result.fallback_email = f"info@{result.domain}"

    # MX verify (fast — skip impressum parsing if domain doesn't even have MX)
    if verify_mx:
        result.mx_verified = _mx_verify(result.domain)
    else:
        result.mx_verified = True

    if not result.mx_verified:
        result.error = "no_mx"
        result.best_email = result.fallback_email
        return result

    # Fetch homepage
    homepage = _fetch(url if "://" in url else f"https://{url}")
    if not homepage:
        result.error = "fetch_failed"
        result.best_email = result.fallback_email
        return result

    # Find impressum link
    impressum_url = _find_impressum_url(url, homepage)
    if impressum_url:
        result.impressum_url = impressum_url
        impressum_html = _fetch(impressum_url) or ""
    else:
        impressum_html = homepage  # try on homepage itself

    # Strip HTML tags for text parsing
    impressum_text = re.sub(r"<[^>]+>", " ", impressum_html)

    # Extract owner
    full, first, last = _extract_owner(impressum_text)
    if full:
        result.owner_name = full
        result.first_name = first
        result.last_name  = last
        result.email_candidates = _build_email_candidates(first, last, result.domain)
        result.best_email = result.email_candidates[0]  # vorname.nachname@ is most common in CH
    else:
        result.best_email = result.fallback_email

    return result


def process_csv(input_path: str, output_path: str, verify_mx: bool = True):
    rows = []
    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        for row in reader:
            rows.append(row)

    new_fields = ["owner_name", "first_name", "last_name",
                  "best_email", "fallback_email", "email_candidates", "mx_verified", "discovery_error"]
    all_fields = list(fieldnames) + [f for f in new_fields if f not in fieldnames]

    results = []
    for i, row in enumerate(rows):
        website = row.get("website") or row.get("url") or ""
        if not website:
            row.update({f: "" for f in new_fields})
            results.append(row)
            continue
        logger.info(f"[{i+1}/{len(rows)}] Discovering: {website}")
        d = discover(website, verify_mx=verify_mx)
        row.update({
            "owner_name": d.owner_name,
            "first_name": d.first_name,
            "last_name":  d.last_name,
            "best_email": d.best_email,
            "fallback_email": d.fallback_email,
            "email_candidates": "|".join(d.email_candidates),
            "mx_verified": "1" if d.mx_verified else "0",
            "discovery_error": d.error,
        })
        results.append(row)

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=all_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(results)

    logger.info(f"Done. {len(results)} rows written to {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="DLM Owner Discovery")
    parser.add_argument("--url", help="Single URL to discover")
    parser.add_argument("--csv", help="Input CSV file (has 'website' column)")
    parser.add_argument("--out", default="leads_with_emails.csv", help="Output CSV path")
    parser.add_argument("--no-mx", action="store_true", help="Skip MX verification")
    args = parser.parse_args()

    if args.url:
        r = discover(args.url, verify_mx=not args.no_mx)
        print(f"URL:         {r.url}")
        print(f"Owner:       {r.owner_name or '(not found)'}")
        print(f"Best email:  {r.best_email}")
        print(f"Fallback:    {r.fallback_email}")
        print(f"Candidates:  {', '.join(r.email_candidates)}")
        print(f"MX verified: {r.mx_verified}")
        if r.error:
            print(f"Error:       {r.error}")
    elif args.csv:
        process_csv(args.csv, args.out, verify_mx=not args.no_mx)
    else:
        parser.print_help()
