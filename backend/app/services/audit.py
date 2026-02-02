from __future__ import annotations

import uuid
from datetime import date, datetime
from enum import Enum
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    return str(value)


async def audit_log(
    session: AsyncSession,
    *,
    actor: str,
    entity_type: str,
    entity_id: uuid.UUID,
    action: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    session.add(
        AuditLog(
            actor=actor,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            before=_jsonable(before) if before is not None else None,
            after=_jsonable(after) if after is not None else None,
        )
    )
