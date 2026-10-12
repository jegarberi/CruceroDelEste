"""drop unique on passengers.seat_id

Revision ID: c7a2e9d4
Revises: 102018def900
Create Date: 2026-10-10

"""
from alembic import op


revision = "c7a2e9d4"
down_revision = "102018def900"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # El UNIQUE global impedía revender un asiento liberado: el pasajero de la
    # reserva expirada/reembolsada queda como historial y chocaba con el nuevo.
    op.drop_constraint("passengers_seat_id_key", "passengers", type_="unique")
    op.create_index("idx_passengers_seat", "passengers", ["seat_id"])


def downgrade() -> None:
    # Falla si ya hay asientos revendidos (más de un pasajero por seat_id).
    op.drop_index("idx_passengers_seat", table_name="passengers")
    op.create_unique_constraint("passengers_seat_id_key", "passengers", ["seat_id"])
