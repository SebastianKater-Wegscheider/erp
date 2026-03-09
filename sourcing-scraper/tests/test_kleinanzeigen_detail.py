from __future__ import annotations

from app.platforms.kleinanzeigen import _detail_needs_http_fallback, _merge_listing_detail_sources


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
