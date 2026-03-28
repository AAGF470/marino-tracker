import sqlite3
from datetime import datetime, timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "data/gym.db"


@app.get("/api/live")
def get_live():
    """
    Returns current occupancy for all rooms.
    Combines marino_live and squash_live tables.
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM marino_live UNION ALL SELECT * FROM squash_live")
        rows = cursor.fetchall()
    return [dict(row) for row in rows]


@app.get("/api/history")
def get_history(room: str = None, days: int = 7):
    """
    Returns historical readings for the last N days.
    Combines marino_historical and squash_historical.
    Safely returns empty list if no data exists yet.

    Args:
        room: optional room name filter
        days: how many days back to query, default 7
    """
    since = (datetime.now() - timedelta(days=days)).isoformat()

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        if room:
            cursor.execute("""
                SELECT room_name, count, capacity, polled_at,
                       day_of_week, temperature, weather, academic_term
                FROM marino_historical
                WHERE polled_at >= ? AND room_name = ?
                UNION ALL
                SELECT room_name, count, capacity, polled_at,
                       day_of_week, temperature, weather, academic_term
                FROM squash_historical
                WHERE polled_at >= ? AND room_name = ?
                ORDER BY polled_at ASC
            """, (since, room, since, room))
        else:
            cursor.execute("""
                SELECT room_name, count, capacity, polled_at,
                       day_of_week, temperature, weather, academic_term
                FROM marino_historical
                WHERE polled_at >= ?
                UNION ALL
                SELECT room_name, count, capacity, polled_at,
                       day_of_week, temperature, weather, academic_term
                FROM squash_historical
                WHERE polled_at >= ?
                ORDER BY polled_at ASC
            """, (since, since))

        rows = cursor.fetchall()

    if not rows:
        return []

    return [dict(row) for row in rows]


@app.get("/api/health")
def health():
    """Simple health check endpoint."""
    return {"status": "ok", "timestamp": datetime.now().isoformat()}