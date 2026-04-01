"""
Website scoring module for DLM Digital lead qualification.
Score 0-100: higher = more potential for DLM services (more gaps to fill).
"""

import time
import re
import ssl
import socket
import requests
from urllib.parse import urlparse
from dataclasses import dataclass, field
from typing import Optional


TIMEOUT = 10
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 11; Pixel 5) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/90.0.4430.91 Mobile Safari/537.36"
    )
}

CONFIGURATOR_PATTERNS = [
    r"rechner", r"konfigurator", r"calculator", r"kalkulator",
    r"preisrechner", r"angebot.*berechnen", r"berechnen.*angebot",
    r"solar.*rechner", r"kuechen.*planer", r"bad.*planer",
]

ADS_PATTERNS = [
    r"googletagmanager\.com/gtm\.js",
    r"googletag\.cmd",
    r"adsbygoogle",
    r"doubleclick\.net",
    r"pagead2\.googlesyndication\.com",
    r"google_ad_",
]

IMPRESSUM_PATTERNS = [
    r"impressum", r"rechtliche.*hinweise", r"mentions.*l.gales",
    r"legal.*notice", r"/impressum", r"impressum\.html",
]

MODERN_FRAMEWORK_SIGNALS = [
    r"react", r"vue\.js", r"angular", r"next\.js", r"nuxt",
    r"tailwind", r"bootstrap/5\.", r"bulma",
]

OLD_DESIGN_SIGNALS = [
    r"bootstrap/3\.", r"bootstrap/2\.", r"jquery/1\.",
    r"joomla", r"table.*width=", r"<font ", r"<center>",
]


@dataclass
class ScoreResult:
    url: str
    total_score: int = 0
    ssl_ok: bool = False
    load_time_ms: int = 0
    mobile_optimized: bool = False
    has_impressum: bool = False
    has_google_ads: bool = False
    has_configurator: bool = False
    is_modern_design: bool = False
    reasons: list = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self):
        return {
            "url": self.url,
            "score": self.total_score,
            "ssl": self.ssl_ok,
            "load_time_ms": self.load_time_ms,
            "mobile_optimized": self.mobile_optimized,
            "has_impressum": self.has_impressum,
            "has_google_ads": self.has_google_ads,
            "has_configurator": self.has_configurator,
            "modern_design": self.is_modern_design,
            "reasons": "; ".join(self.reasons),
            "error": self.error or "",
        }


def _check_ssl(url: str) -> bool:
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(socket.socket(), server_hostname=hostname) as s:
            s.settimeout(5)
            s.connect((hostname, 443))
        return True
    except Exception:
        return False


def score_website(url: str) -> ScoreResult:
    result = ScoreResult(url=url)

    if not url.startswith(("http://", "https://")):
        url = "https://" + url
        result.url = url

    # --- SSL check ---
    result.ssl_ok = _check_ssl(url)
    if not result.ssl_ok:
        result.total_score += 10
        result.reasons.append("Kein SSL → +10 Potenzial")

    # --- Fetch page ---
    try:
        start = time.time()
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        elapsed_ms = int((time.time() - start) * 1000)
        result.load_time_ms = elapsed_ms
        html = resp.text.lower()

        # Speed check
        if elapsed_ms > 3000:
            result.total_score += 10
            result.reasons.append(f"Langsam ({elapsed_ms}ms) → +10 Potenzial")

        # Mobile optimization
        if "viewport" in html and "width=device-width" in html:
            result.mobile_optimized = True
        else:
            result.total_score += 20
            result.reasons.append("Nicht mobile-optimiert → +20 Potenzial")

        # Impressum (Swiss legal requirement)
        for pattern in IMPRESSUM_PATTERNS:
            if re.search(pattern, html):
                result.has_impressum = True
                break
        if not result.has_impressum:
            result.total_score += 5
            result.reasons.append("Kein Impressum CH → +5 Potenzial")

        # Google Ads
        for pattern in ADS_PATTERNS:
            if re.search(pattern, html):
                result.has_google_ads = True
                break
        if not result.has_google_ads:
            result.total_score += 15
            result.reasons.append("Keine Google Ads → +15 Potenzial")

        # Configurator / Calculator
        for pattern in CONFIGURATOR_PATTERNS:
            if re.search(pattern, html):
                result.has_configurator = True
                break
        if not result.has_configurator:
            result.total_score += 20
            result.reasons.append("Kein Rechner/Konfigurator → +20 Potenzial")

        # Design modernity
        old_signals = sum(1 for p in OLD_DESIGN_SIGNALS if re.search(p, html))
        modern_signals = sum(1 for p in MODERN_FRAMEWORK_SIGNALS if re.search(p, html))
        if old_signals > modern_signals:
            result.total_score += 15
            result.reasons.append("Veraltetes Design → +15 Potenzial")
        else:
            result.is_modern_design = True

        # Cap at 100
        result.total_score = min(result.total_score, 100)

    except requests.exceptions.Timeout:
        result.error = "timeout"
        result.total_score = 50
        result.reasons.append("Timeout — Website erreichbar aber sehr langsam")
    except requests.exceptions.SSLError:
        result.error = "ssl_error"
        result.ssl_ok = False
        result.total_score = 60
        result.reasons.append("SSL-Fehler — Website nicht sicher")
    except requests.exceptions.ConnectionError:
        result.error = "connection_error"
        result.total_score = 30
        result.reasons.append("Verbindungsfehler — Website offline?")
    except Exception as e:
        result.error = str(e)[:100]
        result.total_score = 30

    return result
