from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.files import download_file
from app.core.config import get_settings


@pytest.mark.asyncio
async def test_download_file_returns_file_response_with_no_cache_headers(db_engine) -> None:
    settings = get_settings()
    file_path = settings.app_storage_dir / "pdfs" / "invoice.pdf"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(b"test")

    response = await download_file("pdfs/invoice.pdf")

    assert Path(response.path) == file_path
    assert response.headers.get("Cache-Control") == "no-store"
    assert response.headers.get("Pragma") == "no-cache"
    assert response.headers.get("Expires") == "0"


@pytest.mark.asyncio
async def test_download_file_rejects_non_whitelisted_root(db_engine) -> None:
    with pytest.raises(HTTPException) as exc:
        await download_file("secret/data.txt")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_download_file_rejects_path_traversal(db_engine) -> None:
    with pytest.raises(HTTPException) as exc:
        await download_file("pdfs/../../etc/passwd")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_download_file_returns_404_for_missing_file(db_engine) -> None:
    with pytest.raises(HTTPException) as exc:
        await download_file("uploads/missing.jpg")
    assert exc.value.status_code == 404
