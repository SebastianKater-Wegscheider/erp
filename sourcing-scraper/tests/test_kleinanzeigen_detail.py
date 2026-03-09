from __future__ import annotations

from app.platforms.kleinanzeigen import (
    _dedupe_image_urls,
    _detail_needs_http_fallback,
    _extract_listing_detail_from_html,
    _merge_listing_detail_sources,
)


def test_detail_needs_http_fallback_when_description_missing() -> None:
    detail = {
        "title": "Nintendo GameCube Set",
        "description_full": None,
        "posted_at_text": "02.08.2025",
        "image_urls": ["https://img.example/1.jpg"],
    }

    assert _detail_needs_http_fallback(detail) is True


def test_merge_listing_detail_sources_prefers_richer_http_description() -> None:
    agent_detail = {
        "title": "Nintendo GameCube Set – Komplettpaket",
        "description_full": None,
        "posted_at_text": None,
        "image_urls": ["https://img.example/thumb.jpg"],
        "seller_type": "private",
    }
    http_detail = {
        "title": "Nintendo GameCube Set – Komplettpaket",
        "description_full": "Volle Beschreibung mit Lieferumfang und Zustand.",
        "posted_at_text": "02.08.2025",
        "image_urls": [
            "https://img.example/thumb.jpg",
            "https://img.example/2.jpg",
        ],
        "price_cents": 20000,
        "shipping_possible": True,
    }

    merged = _merge_listing_detail_sources(agent_detail, http_detail)

    assert merged["description_full"] == "Volle Beschreibung mit Lieferumfang und Zustand."
    assert merged["posted_at_text"] == "02.08.2025"
    assert merged["price_cents"] == 20000
    assert merged["shipping_possible"] is True
    assert merged["seller_type"] == "private"
    assert merged["image_urls"] == [
        "https://img.example/thumb.jpg",
        "https://img.example/2.jpg",
    ]


def test_extract_listing_detail_from_html_reads_description_from_p_tag() -> None:
    html = """
    <html>
      <body>
        <h1>Nintendo GameCube Set – Komplettpaket</h1>
        <div id="viewad-extra-info"><span>02.08.2025</span></div>
        <p id="viewad-price">200 € VB</p>
        <p id="viewad-description-text" itemprop="description">
          Volle Beschreibung<br />mit Lieferumfang
        </p>
      </body>
    </html>
    """

    detail = _extract_listing_detail_from_html(html)

    assert detail["description_full"] == "Volle Beschreibung mit Lieferumfang"
    assert detail["posted_at_text"] == "02.08.2025"
    assert detail["price_cents"] == 20000


def test_dedupe_image_urls_collapses_kleinanzeigen_rule_variants() -> None:
    urls = [
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.AUTO",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_2.AUTO",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_35.AUTO",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_57.AUTO",
    ]

    deduped = _dedupe_image_urls(urls)

    assert deduped == [
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/04/asset-a?rule=$_59.JPG",
        "https://img.kleinanzeigen.de/api/v1/prod-ads/images/05/asset-b?rule=$_57.AUTO",
    ]
