import sqlite3
from datetime import datetime, timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from predictor import ultra_quiet_threshold

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


@app.get("/api/forecast")
def get_forecast(room: str = None):
    """
    Returns the latest occupancy forecast for the next 24 hours.
    Combines marino_forecast and squash_forecast — each holds only the
    most recent generation, written by predictor.py.

    Args:
        room: optional room name filter
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        if room:
            cursor.execute("""
                SELECT room_name, predicted_time, predicted_count, generated_at
                FROM marino_forecast
                WHERE room_name = ?
                UNION ALL
                SELECT room_name, predicted_time, predicted_count, generated_at
                FROM squash_forecast
                WHERE room_name = ?
                ORDER BY predicted_time ASC
            """, (room, room))
        else:
            cursor.execute("""
                SELECT room_name, predicted_time, predicted_count, generated_at
                FROM marino_forecast
                UNION ALL
                SELECT room_name, predicted_time, predicted_count, generated_at
                FROM squash_forecast
                ORDER BY predicted_time ASC
            """)

        rows = cursor.fetchall()

    return [dict(row) for row in rows]


@app.get("/api/baseline")
def get_baseline(room: str = None, day: str = None):
    """
    Returns the model's typical-week curve: predicted occupancy for every
    15-minute slot of the week (ET), weighted toward recent data.
    Lets the frontend answer "how busy is Wednesday at 8am?" for any slot,
    beyond the 24-hour /api/forecast window.

    Args:
        room: optional room name filter
        day:  optional day filter e.g. "Wednesday"
    """
    conditions = []
    params = []
    if room:
        conditions.append("room_name = ?")
        params.append(room)
    if day:
        conditions.append("day_of_week = ?")
        params.append(day.capitalize())
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(f"""
            SELECT room_name, slot, day_of_week, time_of_day,
                   predicted_count, generated_at
            FROM marino_baseline {where}
            UNION ALL
            SELECT room_name, slot, day_of_week, time_of_day,
                   predicted_count, generated_at
            FROM squash_baseline {where}
            ORDER BY slot ASC
        """, (*params, *params))
        rows = cursor.fetchall()

    return [dict(row) for row in rows]


@app.get("/api/quiet")
def get_quiet(room: str = None):
    """
    Returns ultra-quiet windows per room — stretches where the room is open
    but predicted to hold barely-noticeable numbers of people — plus each
    room's ultra-quiet headcount threshold.
    kind='next24' windows use UTC timestamps; kind='typical' use ET day+times.

    Args:
        room: optional room name filter
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        if room:
            cursor.execute("""
                SELECT room_name, kind, day_of_week, start_time, end_time, generated_at
                FROM quiet_windows WHERE room_name = ?
            """, (room,))
        else:
            cursor.execute("""
                SELECT room_name, kind, day_of_week, start_time, end_time, generated_at
                FROM quiet_windows
            """)
        windows = [dict(r) for r in cursor.fetchall()]

        cursor.execute("SELECT room_name, capacity FROM marino_live UNION ALL SELECT room_name, capacity FROM squash_live")
        thresholds = {r["room_name"]: ultra_quiet_threshold(r["capacity"] or 0)
                      for r in cursor.fetchall()}

    return {"thresholds": thresholds, "windows": windows}


@app.get("/api/health")
def health():
    """Simple health check endpoint."""
    return {"status": "ok", "timestamp": datetime.now().isoformat()}