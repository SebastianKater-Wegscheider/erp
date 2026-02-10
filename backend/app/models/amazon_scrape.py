from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class AmazonScrapeRun(Base):
    __tablename__ = "amazon_scrape_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    master_product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("master_products.id", ondelete="CASCADE"), nullable=False, index=True
    )

    asin: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    marketplace: Mapped[str] = mapped_column(String(32), nullable=False, default="amazon.de")

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    block_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    offers_truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    dp_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    offer_listing_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivery_zip: Mapped[str | None] = mapped_column(String(32), nullable=True)

    sales_ranks: Mapped[list["AmazonScrapeSalesRank"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        order_by="AmazonScrapeSalesRank.idx",
    )
    best_prices: Mapped[list["AmazonScrapeBestPrice"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
    )


class AmazonScrapeSalesRank(Base):
    __tablename__ = "amazon_scrape_sales_ranks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("amazon_scrape_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    raw: Mapped[str | None] = mapped_column(Text, nullable=True)

    run: Mapped[AmazonScrapeRun] = relationship(back_populates="sales_ranks")


class AmazonScrapeBestPrice(Base):
    __tablename__ = "amazon_scrape_best_prices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("amazon_scrape_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )

    condition_bucket: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    price_total_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="EUR")

    source_offer_page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_offer_position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_seller_name: Mapped[str | None] = mapped_column(Text, nullable=True)

    run: Mapped[AmazonScrapeRun] = relationship(back_populates="best_prices")


class AmazonProductMetricsLatest(Base):
    __tablename__ = "amazon_product_metrics_latest"

    master_product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("master_products.id", ondelete="CASCADE"), primary_key=True
    )

    last_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    blocked_last: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    block_reason_last: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    rank_overall: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rank_overall_category: Mapped[str | None] = mapped_column(Text, nullable=True)
    rank_specific: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rank_specific_category: Mapped[str | None] = mapped_column(Text, nullable=True)

    price_new_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_used_like_new_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_used_very_good_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_used_good_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_used_acceptable_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_collectible_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)

    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
