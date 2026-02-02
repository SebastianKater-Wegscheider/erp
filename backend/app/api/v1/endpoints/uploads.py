from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, File, UploadFile

from app.core.config import get_settings
from app.schemas.uploads import UploadOut


router = APIRouter()


@router.post("", response_model=UploadOut)
async def upload_file(file: UploadFile = File(...)) -> UploadOut:
    settings = get_settings()
    upload_dir = settings.upload_dir
    upload_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix
    name = f"{uuid.uuid4().hex}{suffix}"
    rel_path = f"uploads/{name}"
    abs_path = upload_dir / name

    content = await file.read()
    abs_path.write_bytes(content)
    return UploadOut(upload_path=rel_path)
