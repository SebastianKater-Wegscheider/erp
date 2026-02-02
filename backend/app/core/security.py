from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app.core.config import get_settings


security = HTTPBasic(auto_error=False)


def require_basic_auth(credentials: HTTPBasicCredentials | None = Depends(security)) -> str:
    settings = get_settings()
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required", headers={"WWW-Authenticate": "Basic"})

    valid_user = secrets.compare_digest(credentials.username, settings.basic_auth_username)
    valid_pass = secrets.compare_digest(credentials.password, settings.basic_auth_password)
    if not (valid_user and valid_pass):
        raise HTTPException(status_code=401, detail="Invalid credentials", headers={"WWW-Authenticate": "Basic"})
    return credentials.username

