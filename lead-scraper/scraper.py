"""
Google Maps Playwright scraper for Swiss KMU leads — no API key required.
Uses headless Chromium to scrape Google Maps search results directly.

Setup:
    pip install playwright
    playwright install chromium
"""

import time
import logging
import random
from typing import Generator

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

logger = logging.getLogger(__name__)

# Target Swiss cantons
CANTONS = [
    "Zürich",
    "Bern",
    "Luzern",
    "St. Gallen",
    "Aarau",
    "Basel",
    "Lausanne",
    "Genf",
]

# Business keywords (German + French for VD/GE)
KEYWORDS = [
    "Küchenstudio",
    "Sanitär",
    "Solaranlagen",
    "Treuhand",
    "Autogarage",
    "Coiffeur",
    "Zahnarzt",
    "cuisine équipée",
    "plomberie",
    "énergie solaire",
    "fiduciaire",
    "garage automobile",
    "dentiste",
]

MAPS_BASE = "https://www.google.com/maps/search/"


def _accept_consent(page) -> None:
    """Dismiss Google consent / cookie dialog if present."""
    try:
        # Google consent buttons vary by locale; try common selectors
        for selector in [
            'button[aria-label*="Alle akzeptieren"]',
            'button[aria-label*="Accept all"]',
            'button[aria-label*="Tout accepter"]',
            'form[action*="consent"] button',
        ]:
            btn = page.query_selector(selector)
            if btn:
                btn.click()
                page.wait_for_timeout(800)
                return
    except Exception:
        pass


def _scroll_results_panel(page, max_results: int = 60) -> None:
    """Scroll the left results panel until we have enough results or hit the end."""
    panel_selector = 'div[role="feed"]'
    try:
        panel = page.query_selector(panel_selector)
        if not panel:
            return
        prev_count = 0
        stall_count = 0
        while True:
            cards = page.query_selector_all('a[href*="/maps/place/"]')
            current_count = len(cards)
            if current_count >= max_results:
                break
            if current_count == prev_count:
                stall_count += 1
                if stall_count >= 3:
                    break
            else:
                stall_count = 0
            prev_count = current_count
            panel.evaluate("el => el.scrollBy(0, 800)")
            page.wait_for_timeout(random.randint(600, 1000))
    except Exception as e:
        logger.debug(f"Scroll error: {e}")


def _extract_listing(page) -> dict:
    """Extract business details from the currently open place panel."""
    data = {}
    try:
        # Name
        name_el = page.query_selector('h1[class*="fontHeadlineLarge"]')
        if not name_el:
            name_el = page.query_selector("h1")
        data["name"] = name_el.inner_text().strip() if name_el else ""

        # Rating
        rating_el = page.query_selector('span[aria-label*="Sterne"], span[aria-label*="stars"], span[aria-label*="étoiles"]')
        if rating_el:
            aria = rating_el.get_attribute("aria-label") or ""
            for part in aria.split():
                try:
                    data["rating"] = float(part.replace(",", "."))
                    break
                except ValueError:
                    continue
        data.setdefault("rating", 0)

        # Review count
        reviews_el = page.query_selector('span[aria-label*="Rezension"], span[aria-label*="review"], span[aria-label*="avis"]')
        if reviews_el:
            aria = reviews_el.get_attribute("aria-label") or ""
            num = "".join(filter(str.isdigit, aria.split()[0].replace(".", "").replace(",", "")))
            data["reviews"] = int(num) if num else 0
        data.setdefault("reviews", 0)

        # Address
        address_el = page.query_selector('button[data-item-id="address"]')
        if address_el:
            data["address"] = address_el.inner_text().strip().replace("\n", ", ")
        data.setdefault("address", "")

        # Phone
        phone_el = page.query_selector('button[data-item-id*="phone"]')
        if phone_el:
            data["phone"] = phone_el.inner_text().strip()
        data.setdefault("phone", "")

        # Website
        website_el = page.query_selector('a[data-item-id="authority"]')
        if website_el:
            data["website"] = website_el.get_attribute("href") or ""
        data.setdefault("website", "")

    except Exception as e:
        logger.debug(f"Extract error: {e}")

    return data


def scrape_leads(max_per_query: int = 20) -> Generator[dict, None, None]:
    """
    Yield lead dicts: {name, address, website, phone, rating, reviews, keyword, canton}
    Uses Playwright to scrape Google Maps without an API key.
    """
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="de-CH",
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        # Suppress images/fonts for speed
        page.route(
            "**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf}",
            lambda route: route.abort(),
        )

        seen_names: set = set()

        for canton in CANTONS:
            for keyword in KEYWORDS:
                query = f"{keyword} {canton} Schweiz"
                url = MAPS_BASE + query.replace(" ", "+")
                logger.info(f"Scraping: {query}")

                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                    page.wait_for_timeout(1500)
                    _accept_consent(page)
                    page.wait_for_timeout(1000)

                    # Wait for results panel
                    try:
                        page.wait_for_selector('a[href*="/maps/place/"]', timeout=8_000)
                    except PlaywrightTimeout:
                        logger.warning(f"No results for: {query}")
                        continue

                    _scroll_results_panel(page, max_results=max_per_query)

                    # Collect all place links
                    cards = page.query_selector_all('a[href*="/maps/place/"]')
                    hrefs = []
                    for card in cards[:max_per_query]:
                        href = card.get_attribute("href")
                        if href and href not in hrefs:
                            hrefs.append(href)

                    for href in hrefs:
                        try:
                            page.goto(href, wait_until="domcontentloaded", timeout=15_000)
                            page.wait_for_timeout(1200)

                            details = _extract_listing(page)
                            name = details.get("name", "")
                            website = details.get("website", "")

                            if not name or name in seen_names:
                                continue
                            if not website:
                                continue  # Only leads with a website

                            seen_names.add(name)
                            yield {
                                "name": name,
                                "address": details.get("address", ""),
                                "website": website,
                                "phone": details.get("phone", ""),
                                "rating": details.get("rating", 0),
                                "reviews": details.get("reviews", 0),
                                "keyword": keyword,
                                "canton": canton,
                            }

                            # Polite delay between detail pages
                            page.wait_for_timeout(random.randint(800, 1400))

                        except Exception as e:
                            logger.debug(f"Detail page error ({href[:60]}): {e}")
                            continue

                except Exception as e:
                    logger.warning(f"Query failed ({query}): {e}")
                    continue

                # Polite delay between queries
                time.sleep(random.uniform(2.0, 4.0))

        context.close()
        browser.close()
