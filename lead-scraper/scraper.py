"""
Google Places API scraper for Swiss KMU leads.
Targets specified business categories across Swiss cantons.
"""

import os
import time
import logging
from typing import Generator
import requests

logger = logging.getLogger(__name__)

PLACES_API_BASE = "https://maps.googleapis.com/maps/api/place"

# Target Swiss cantons (city names for geocoding)
CANTONS = [
    "Zürich, Switzerland",
    "Bern, Switzerland",
    "Luzern, Switzerland",
    "St. Gallen, Switzerland",
    "Aarau, Switzerland",      # AG
    "Basel, Switzerland",       # BL/BS
    "Lausanne, Switzerland",    # VD
    "Geneva, Switzerland",      # GE
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
    "cuisine équipée",          # VD/GE
    "plomberie",                # VD/GE
    "énergie solaire",          # VD/GE
    "fiduciaire",               # VD/GE
    "garage automobile",        # VD/GE
    "coiffeur",                 # same
    "dentiste",                 # VD/GE
]


def _get_geocode(location: str, api_key: str) -> tuple[float, float] | None:
    """Get lat/lng for a location string."""
    url = "https://maps.googleapis.com/maps/api/geocode/json"
    resp = requests.get(url, params={"address": location, "key": api_key}, timeout=10)
    data = resp.json()
    if data.get("status") == "OK" and data.get("results"):
        loc = data["results"][0]["geometry"]["location"]
        return loc["lat"], loc["lng"]
    return None


def _text_search_page(
    query: str, api_key: str, page_token: str | None = None
) -> dict:
    params = {
        "query": query,
        "key": api_key,
        "language": "de",
        "region": "ch",
    }
    if page_token:
        params["pagetoken"] = page_token
    resp = requests.get(f"{PLACES_API_BASE}/textsearch/json", params=params, timeout=15)
    return resp.json()


def _get_place_details(place_id: str, api_key: str) -> dict:
    """Fetch website + phone from place details."""
    params = {
        "place_id": place_id,
        "fields": "website,formatted_phone_number,name,formatted_address,rating,user_ratings_total",
        "key": api_key,
        "language": "de",
    }
    resp = requests.get(f"{PLACES_API_BASE}/details/json", params=params, timeout=10)
    data = resp.json()
    return data.get("result", {})


def scrape_leads(api_key: str, max_per_query: int = 60) -> Generator[dict, None, None]:
    """
    Yield lead dicts: {name, address, website, phone, rating, reviews, keyword, canton}
    """
    seen_place_ids: set = set()

    for canton in CANTONS:
        for keyword in KEYWORDS:
            query = f"{keyword} {canton}"
            logger.info(f"Searching: {query}")

            page_token = None
            results_this_query = 0

            while results_this_query < max_per_query:
                if page_token:
                    time.sleep(2)  # Required by Google API between page_token requests

                data = _text_search_page(query, api_key, page_token)
                status = data.get("status")

                if status == "ZERO_RESULTS":
                    break
                if status not in ("OK", "ZERO_RESULTS"):
                    logger.warning(f"API status {status} for query: {query}")
                    break

                for place in data.get("results", []):
                    place_id = place.get("place_id")
                    if not place_id or place_id in seen_place_ids:
                        continue
                    seen_place_ids.add(place_id)

                    # Get details for website + phone
                    details = _get_place_details(place_id, api_key)
                    website = details.get("website", "")

                    if not website:
                        continue  # Skip leads without a website

                    yield {
                        "place_id": place_id,
                        "name": place.get("name", ""),
                        "address": place.get("formatted_address", ""),
                        "website": website,
                        "phone": details.get("formatted_phone_number", ""),
                        "rating": place.get("rating", 0),
                        "reviews": place.get("user_ratings_total", 0),
                        "keyword": keyword,
                        "canton": canton.split(",")[0],
                    }
                    results_this_query += 1

                page_token = data.get("next_page_token")
                if not page_token:
                    break

            # Respect Google rate limits
            time.sleep(0.5)
