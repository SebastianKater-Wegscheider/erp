"""switch sourcing keyword defaults to gamecube

Revision ID: 8e2b7f4c1d33
Revises: 1d4f7b6c9a21
Create Date: 2026-02-17 19:10:00.000000
"""

from __future__ import annotations

from alembic import op


# revision identifiers, used by Alembic.
revision = "8e2b7f4c1d33"
down_revision = "1d4f7b6c9a21"
branch_labels = None
depends_on = None


def _replace_search_term(old: str, new: str) -> None:
    op.execute(
        f"""
        UPDATE sourcing_settings
        SET value_json = (
            SELECT COALESCE(
                jsonb_agg(
                    CASE WHEN lower(term) = '{old.lower()}' THEN '{new}' ELSE term END
                ),
                '[]'::jsonb
            )
            FROM jsonb_array_elements_text(COALESCE(value_json, '[]'::jsonb)) AS entry(term)
        ),
        updated_at = now()
        WHERE key = 'search_terms';
        """
    )


def _replace_agent_keyword(old: str, new: str) -> None:
    op.execute(
        f"""
        UPDATE sourcing_agent_queries
        SET keyword = '{new}',
            updated_at = now()
        WHERE lower(trim(keyword)) = '{old.lower()}';
        """
    )


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO sourcing_settings (key, value_int, value_text, value_json, description)
        VALUES (
            'search_terms',
            NULL,
            NULL,
            '["videospiele konvolut", "retro spiele sammlung", "gamecube spiele paket"]'::jsonb,
            'Search terms for sourcing scraper'
        )
        ON CONFLICT (key) DO NOTHING
        """
    )

    _replace_search_term("nintendo spiele paket", "gamecube spiele paket")
    _replace_agent_keyword("nintendo", "gamecube")


def downgrade() -> None:
    _replace_search_term("gamecube spiele paket", "nintendo spiele paket")
    _replace_agent_keyword("gamecube", "nintendo")
