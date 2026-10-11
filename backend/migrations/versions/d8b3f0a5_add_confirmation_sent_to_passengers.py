"""add confirmation_sent to passengers

Revision ID: d8b3f0a5
Revises: c7a2e9d4
Create Date: 2026-10-11

"""
import sqlalchemy as sa
from alembic import op


revision = "d8b3f0a5"
down_revision = "c7a2e9d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Los pasajeros que ya existen quedan como enviados: si no, la primera
    # corrida de retry_confirmation_emails_job les reenviaría la confirmación.
    op.add_column(
        "passengers",
        sa.Column("confirmation_sent", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.alter_column("passengers", "confirmation_sent", server_default=sa.text("false"))


def downgrade() -> None:
    op.drop_column("passengers", "confirmation_sent")
