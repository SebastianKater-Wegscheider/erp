from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.core.config import get_settings


router = APIRouter()


@router.get("/{file_path:path}")
async def download_file(file_path: str) -> FileResponse:
    """
    Download files from the app storage.
    Allowed roots: /data/pdfs and /data/uploads (mounted via docker-compose).
    """
    settings = get_settings()

    rel = file_path.lstrip("/")
    if not (rel.startswith("pdfs/") or rel.startswith("uploads/")):
        raise HTTPException(status_code=403, detail="Forbidden path")

    base_dir = settings.app_storage_dir.resolve()
    abs_path = (settings.app_storage_dir / rel).resolve()
    try:
        abs_path.relative_to(base_dir)
    except ValueError as e:
        raise HTTPException(status_code=403, detail="Forbidden path") from e

    if not abs_path.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    return FileResponse(path=str(abs_path), filename=Path(rel).name)

