import sqlite3
from pathlib import Path
from datetime import datetime

DB_PATH = "data/gym.db"

def init_db() -> None:
    """
    Creates all tables if they don't exist.
    Safe to call on every startup — IF NOT EXISTS prevents data loss.
    """
    Path("data").mkdir(exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS marino_live (
            room_name    TEXT PRIMARY KEY,
            count        INTEGER,
            capacity     INTEGER,
            is_closed    INTEGER,
            last_updated TEXT,
            polled_at    TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS marino_historical (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name     TEXT,
            count         INTEGER,
            capacity      INTEGER,
            is_closed     INTEGER,
            last_updated  TEXT,
            polled_at     TEXT,
            day_of_week   TEXT,
            month         INTEGER,
            year          INTEGER,
            season        TEXT,
            is_weekend    INTEGER,
            is_finals     INTEGER,
            is_break      INTEGER,
            academic_term TEXT,
            weather       TEXT,
            limited_hours INTEGER,
            temperature   REAL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS squash_live (
            room_name    TEXT PRIMARY KEY,
            count        INTEGER,
            capacity     INTEGER,
            is_closed    INTEGER,
            last_updated TEXT,
            polled_at    TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS squash_historical (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name     TEXT,
            count         INTEGER,
            capacity      INTEGER,
            is_closed     INTEGER,
            last_updated  TEXT,
            polled_at     TEXT,
            day_of_week   TEXT,
            month         INTEGER,
            year          INTEGER,
            season        TEXT,
            is_weekend    INTEGER,
            is_finals     INTEGER,
            is_break      INTEGER,
            academic_term TEXT,
            weather       TEXT,
            limited_hours INTEGER,
            temperature   REAL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS calendar (
            key         TEXT PRIMARY KEY,
            value       TEXT,
            description TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS marino_forecast (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name       TEXT,
            predicted_time  TEXT,
            predicted_count INTEGER,
            generated_at    TEXT,
            model_version   INTEGER
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS squash_forecast (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name       TEXT,
            predicted_time  TEXT,
            predicted_count INTEGER,
            generated_at    TEXT,
            model_version   INTEGER
        )
    """)

    conn.commit()
    conn.close()


def write_live(facility: str, room_name: str, count: int, capacity: int,
               is_closed: bool, last_updated: datetime, polled_at: datetime) -> None:
    """
    Overwrites the current live row for this room.
    Uses INSERT OR REPLACE keyed on room_name.

    Args:
        facility:     "marino" or "squash"
        room_name:    name of the room
        count:        current headcount
        capacity:     maximum capacity
        is_closed:    whether the room is closed
        last_updated: timestamp from the API
        polled_at:    timestamp when poller fetched the data
    """
    table = f"{facility}_live"
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute(f"""
            INSERT OR REPLACE INTO {table}
            (room_name, count, capacity, is_closed, last_updated, polled_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (room_name, count, capacity, int(is_closed),
              last_updated.isoformat(), polled_at.isoformat()))
        conn.commit()


def write_historical(facility: str, room_name: str, count: int, capacity: int,
                     is_closed: bool, last_updated: datetime, polled_at: datetime,
                     day_of_week: str, month: int, year: int, season: str,
                     is_weekend: bool, is_finals: bool, is_break: bool,
                     academic_term: str, weather: str, limited_hours: bool,
                     temperature: float) -> None:
    """
    Appends a new row to historical — never overwrites.

    Args:
        facility:      "marino" or "squash"
        room_name:     name of the room
        count:         current headcount
        capacity:      maximum capacity
        is_closed:     whether the room is closed
        last_updated:  timestamp from the API
        polled_at:     timestamp when poller fetched the data
        day_of_week:   e.g. "Monday"
        month:         1-12
        year:          e.g. 2026
        season:        "Spring" | "Summer" | "Fall" | "Winter"
        is_weekend:    whether it is a weekend
        is_finals:     whether it is finals period
        is_break:      whether it is a break period
        academic_term: e.g. "Spring 2026"
        weather:       e.g. "clear" | "snow" | "rain"
        limited_hours: whether gym is on reduced hours schedule
        temperature:   current temperature in Fahrenheit
    """
    table = f"{facility}_historical"
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute(f"""
            INSERT INTO {table}
            (room_name, count, capacity, is_closed, last_updated, polled_at,
             day_of_week, month, year, season, is_weekend, is_finals,
             is_break, academic_term, weather, limited_hours, temperature)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (room_name, count, capacity, int(is_closed),
              last_updated.isoformat(), polled_at.isoformat(),
              day_of_week, month, year, season,
              int(is_weekend), int(is_finals), int(is_break),
              academic_term, weather, int(limited_hours), temperature))
        conn.commit()