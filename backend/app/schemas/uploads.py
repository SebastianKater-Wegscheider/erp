from __future__ import annotations

from pydantic import BaseModel, Field


class UploadOut(BaseModel):
    upload_path: str = Field(..., description="Relative path under APP_STORAGE_DIR/uploads")

