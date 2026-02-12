from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import get_session
from app.core.config import get_settings
from app.core.security import require_basic_auth
from app.schemas.mileage import MileageOut
from app.models.purchase import Purchase
from app.models.purchase_attachment import PurchaseAttachment
from app.schemas.purchase_attachment import (
    PurchaseAttachmentBatchCreate,
    PurchaseAttachmentOut,
)
from app.schemas.purchase import PurchaseCreate, PurchaseOut, PurchaseRefOut, PurchaseUpdate
from app.schemas.purchase_mileage import PurchaseMileageUpsert
from app.services.purchases import (
    CANONICAL_SOURCE_PLATFORMS,
    create_purchase,
    delete_purchase_primary_mileage,
    generate_purchase_credit_note_pdf,
    get_purchase_primary_mileage,
    normalize_source_platform_label,
    reopen_purchase_for_edit,
    upsert_purchase_primary_mileage,
    update_purchase,
)


router = APIRouter()

@router.post("", response_model=PurchaseOut)
async def create_purchase_endpoint(
    data: PurchaseCreate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> PurchaseOut:
    try:
        async with session.begin():
            purchase = await create_purchase(session, actor=actor, data=data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    await session.refresh(purchase)
    purchase = (
        await session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    return PurchaseOut.model_validate(purchase)


@router.get("", response_model=list[PurchaseOut])
async def list_purchases(session: AsyncSession = Depends(get_session)) -> list[PurchaseOut]:
    rows = (
        await session.execute(select(Purchase).order_by(Purchase.purchase_date.desc()).options(selectinload(Purchase.lines)))
    ).scalars().all()
    return [PurchaseOut.model_validate(r) for r in rows]


@router.get("/refs", response_model=list[PurchaseRefOut])
async def list_purchase_refs(session: AsyncSession = Depends(get_session)) -> list[PurchaseRefOut]:
    rows = (await session.execute(select(Purchase).order_by(Purchase.purchase_date.desc()))).scalars().all()
    return [PurchaseRefOut.model_validate(r) for r in rows]


@router.get("/source-platforms", response_model=list[str])
async def list_purchase_source_platforms(session: AsyncSession = Depends(get_session)) -> list[str]:
    rows = (
        await session.execute(
            select(Purchase.source_platform)
            .where(Purchase.source_platform.is_not(None))
            .order_by(Purchase.source_platform.asc())
        )
    ).scalars().all()
    out = set(CANONICAL_SOURCE_PLATFORMS)
    for value in rows:
        normalized = normalize_source_platform_label(str(value or "").strip())
        if normalized:
            out.add(normalized)
    return sorted(out, key=str.casefold)


@router.get("/{purchase_id}/attachments", response_model=list[PurchaseAttachmentOut])
async def list_purchase_attachments(
    purchase_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> list[PurchaseAttachmentOut]:
    if await session.get(Purchase, purchase_id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    rows = (
        await session.execute(
            select(PurchaseAttachment)
            .where(PurchaseAttachment.purchase_id == purchase_id)
            .order_by(PurchaseAttachment.created_at.desc())
        )
    ).scalars().all()
    return [PurchaseAttachmentOut.model_validate(r) for r in rows]


@router.post("/{purchase_id}/attachments", response_model=list[PurchaseAttachmentOut])
async def add_purchase_attachments(
    purchase_id: uuid.UUID,
    data: PurchaseAttachmentBatchCreate,
    session: AsyncSession = Depends(get_session),
) -> list[PurchaseAttachmentOut]:
    if await session.get(Purchase, purchase_id) is None:
        raise HTTPException(status_code=404, detail="Not found")

    rows = [
        PurchaseAttachment(
            purchase_id=purchase_id,
            upload_path=attachment.upload_path.lstrip("/"),
            original_filename=str(attachment.original_filename or "").strip() or attachment.upload_path.split("/")[-1],
            kind=str(attachment.kind or "OTHER").strip().upper() or "OTHER",
            note=attachment.note,
        )
        for attachment in data.attachments
    ]
    session.add_all(rows)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Attachment already linked to purchase") from e
    return [PurchaseAttachmentOut.model_validate(row) for row in rows]


@router.delete("/{purchase_id}/attachments/{attachment_id}", status_code=204)
async def delete_purchase_attachment(
    purchase_id: uuid.UUID,
    attachment_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    row = await session.get(PurchaseAttachment, attachment_id)
    if row is None or row.purchase_id != purchase_id:
        raise HTTPException(status_code=404, detail="Not found")
    await session.delete(row)
    await session.commit()
    return Response(status_code=204)


@router.get("/{purchase_id}", response_model=PurchaseOut)
async def get_purchase(purchase_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> PurchaseOut:
    row = (
        await session.execute(select(Purchase).where(Purchase.id == purchase_id).options(selectinload(Purchase.lines)))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return PurchaseOut.model_validate(row)


@router.get("/{purchase_id}/mileage", response_model=MileageOut | None)
async def get_purchase_mileage(
    purchase_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> MileageOut | None:
    try:
        row = await get_purchase_primary_mileage(session, purchase_id=purchase_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return MileageOut.model_validate(row) if row is not None else None


@router.put("/{purchase_id}/mileage", response_model=MileageOut)
async def upsert_purchase_mileage(
    purchase_id: uuid.UUID,
    data: PurchaseMileageUpsert,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> MileageOut:
    settings = get_settings()
    try:
        async with session.begin():
            row = await upsert_purchase_primary_mileage(
                session,
                actor=actor,
                purchase_id=purchase_id,
                data=data,
                rate_cents_per_km=settings.mileage_rate_cents_per_km,
            )
    except ValueError as e:
        raise HTTPException(status_code=404 if str(e) == "Purchase not found" else 409, detail=str(e)) from e
    return MileageOut.model_validate(row)


@router.delete("/{purchase_id}/mileage", status_code=204)
async def delete_purchase_mileage(
    purchase_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> Response:
    try:
        async with session.begin():
            await delete_purchase_primary_mileage(session, actor=actor, purchase_id=purchase_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return Response(status_code=204)


@router.put("/{purchase_id}", response_model=PurchaseOut)
async def update_purchase_endpoint(
    purchase_id: uuid.UUID,
    data: PurchaseUpdate,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> PurchaseOut:
    try:
        async with session.begin():
            purchase = await update_purchase(session, actor=actor, purchase_id=purchase_id, data=data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    purchase = (
        await session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    return PurchaseOut.model_validate(purchase)


@router.post("/{purchase_id}/generate-pdf", response_model=PurchaseOut)
async def generate_purchase_pdf(
    purchase_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> PurchaseOut:
    try:
        async with session.begin():
            purchase = await generate_purchase_credit_note_pdf(session, actor=actor, purchase_id=purchase_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    purchase = (
        await session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    return PurchaseOut.model_validate(purchase)


@router.post("/{purchase_id}/reopen", response_model=PurchaseOut)
async def reopen_purchase_endpoint(
    purchase_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    actor: str = Depends(require_basic_auth),
) -> PurchaseOut:
    try:
        async with session.begin():
            purchase = await reopen_purchase_for_edit(session, actor=actor, purchase_id=purchase_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    purchase = (
        await session.execute(select(Purchase).where(Purchase.id == purchase.id).options(selectinload(Purchase.lines)))
    ).scalar_one()
    return PurchaseOut.model_validate(purchase)
