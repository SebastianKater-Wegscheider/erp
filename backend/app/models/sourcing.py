from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import SourcingPlatform, SourcingStatus
from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.sql_enums import sourcing_platform_enum, sourcing_status_enum

if TYPE_CHECKING:
    from app.models.master_product import MasterProduct
    from app.models.purchase import Purchase


class SourcingAgent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sourcing_agents"
    __table_args__ = (
        Index("ix_sourcing_agents_enabled_next_run_at", "enabled", "next_run_at"),
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=21_600)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    queries: Mapped[list["SourcingAgentQuery"]] = relationship(back_populates="agent", cascade="all, delete-orphan")
    runs: Mapped[list["SourcingRun"]] = relationship(back_populates="agent")
    items: Mapped[list["SourcingItem"]] = relationship(back_populates="agent")


class SourcingAgentQuery(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sourcing_agent_queries"
    __table_args__ = (
        UniqueConstraint("agent_id", "platform", "keyword", name="uq_sourcing_agent_query_platform_keyword"),
        Index("ix_sourcing_agent_queries_agent_id", "agent_id"),
        Index("ix_sourcing_agent_queries_enabled", "enabled"),
    )

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_agents.id", ondelete="CASCADE"),
        nullable=False,
    )
    platform: Mapped[SourcingPlatform] = mapped_column(sourcing_platform_enum, nullable=False)
    keyword: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_pages: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    detail_enrichment_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    options_json: Mapped[dict | list | None] = mapped_column(JSONB, nullable=True)

    agent: Mapped[SourcingAgent] = relationship(back_populates="queries")
    runs: Mapped[list["SourcingRun"]] = relationship(back_populates="agent_query")
    items: Mapped[list["SourcingItem"]] = relationship(back_populates="agent_query")


class SourcingRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sourcing_runs"

    trigger: Mapped[str] = mapped_column(String(32), nullable=False, default="scheduler")
    platform: Mapped[SourcingPlatform | None] = mapped_column(sourcing_platform_enum, nullable=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_agents.id", ondelete="SET NULL"),
        nullable=True,
    )
    agent_query_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_agent_queries.id", ondelete="SET NULL"),
        nullable=True,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    error_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    items_scraped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_new: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_ready: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    search_terms: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)

    items: Mapped[list["SourcingItem"]] = relationship(back_populates="run")
    agent: Mapped[SourcingAgent | None] = relationship(back_populates="runs")
    agent_query: Mapped[SourcingAgentQuery | None] = relationship(back_populates="runs")


class SourcingItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sourcing_items"
    __table_args__ = (
        UniqueConstraint("platform", "external_id", name="uq_sourcing_item_platform_external"),
        Index("ix_sourcing_items_status", "status"),
        Index("ix_sourcing_items_scraped_at", "scraped_at"),
        Index("ix_sourcing_items_posted_at", "posted_at"),
        Index("ix_sourcing_items_run_id", "last_run_id"),
        Index("ix_sourcing_items_auction_end_at", "auction_end_at"),
        Index(
            "ix_sourcing_items_ebay_ready_auction_end",
            "platform",
            "status",
            "auction_end_at",
            postgresql_where=text("platform = 'EBAY_DE'"),
        ),
    )

    platform: Mapped[SourcingPlatform] = mapped_column(sourcing_platform_enum, nullable=False)
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    location_zip: Mapped[str | None] = mapped_column(String(10), nullable=True)
    location_city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    seller_type: Mapped[str | None] = mapped_column(String(50), nullable=True)

    image_urls: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    primary_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[SourcingStatus] = mapped_column(sourcing_status_enum, nullable=False, default=SourcingStatus.NEW)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    estimated_revenue_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_profit_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_roi_bp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_purchase_price_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)

    raw_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    scraped_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    auction_end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    auction_current_price_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    auction_bid_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bidbag_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    bidbag_last_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    converted_purchase_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchases.id", ondelete="SET NULL"),
        nullable=True,
    )
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_runs.id", ondelete="SET NULL"),
        nullable=True,
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_agents.id", ondelete="SET NULL"),
        nullable=True,
    )
    agent_query_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_agent_queries.id", ondelete="SET NULL"),
        nullable=True,
    )

    matches: Mapped[list["SourcingMatch"]] = relationship(back_populates="item", cascade="all, delete-orphan")
    converted_purchase: Mapped[Purchase | None] = relationship("Purchase")
    run: Mapped[SourcingRun | None] = relationship(back_populates="items")
    agent: Mapped[SourcingAgent | None] = relationship(back_populates="items")
    agent_query: Mapped[SourcingAgentQuery | None] = relationship(back_populates="items")


class SourcingMatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sourcing_matches"
    __table_args__ = (
        UniqueConstraint("sourcing_item_id", "master_product_id", name="uq_sourcing_match_item_product"),
        CheckConstraint("confidence_score >= 0 AND confidence_score <= 100", name="ck_sourcing_match_confidence_range"),
        Index("ix_sourcing_matches_sourcing_item_id", "sourcing_item_id"),
        Index("ix_sourcing_matches_confidence_score", "confidence_score"),
    )

    sourcing_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sourcing_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    master_product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("master_products.id", ondelete="CASCADE"),
        nullable=False,
    )

    confidence_score: Mapped[int] = mapped_column(Integer, nullable=False)
    match_method: Mapped[str] = mapped_column(String(50), nullable=False)
    matched_substring: Mapped[str | None] = mapped_column(Text, nullable=True)

    user_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    user_rejected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    user_adjusted_condition: Mapped[str | None] = mapped_column(String(20), nullable=True)

    snapshot_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    snapshot_bsr: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot_new_price_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot_used_price_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot_fba_payout_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)

    item: Mapped[SourcingItem] = relationship(back_populates="matches")
    master_product: Mapped[MasterProduct] = relationship("MasterProduct")


class SourcingSetting(Base):
    __tablename__ = "sourcing_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value_int: Mapped[int | None] = mapped_column(Integer, nullable=True)
    value_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    value_json: Mapped[dict | list | None] = mapped_column(JSONB, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
