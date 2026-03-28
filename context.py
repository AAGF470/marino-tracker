import httpx as ht
import sqlite3
from datetime import datetime, date
from zoneinfo import ZoneInfo
import db

"""
List of Variables
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
"""

WEATHER_URL = "https://api.open-meteo.com/v1/forecast?latitude=42.3398&longitude=-71.0892&current=temperature_2m,weathercode&temperature_unit=fahrenheit"

WEATHER_CODES = {
    0:  "clear",
    1:  "mostly clear",
    2:  "partly cloudy",
    3:  "overcast",
    45: "fog",
    48: "fog",
    51: "drizzle",
    53: "drizzle",
    55: "drizzle",
    61: "rain",
    63: "rain",
    65: "heavy rain",
    71: "snow",
    73: "snow",
    75: "heavy snow",
    77: "snow",
    80: "rain showers",
    81: "rain showers",
    82: "heavy rain showers",
    85: "snow showers",
    86: "snow showers",
    95: "thunderstorm",
    96: "thunderstorm",
    99: "thunderstorm",
}


def _in_range(value: str) -> bool:
    """
    Checks if today falls within a MM-DD:MM-DD range.

    Args:
        value: date range string in MM-DD:MM-DD format
    Returns:
        bool: True if today is within the range
    """
    try:
        start, end = value.split(":")
        today = datetime.now().strftime("%m-%d")
        return start <= today <= end
    except ValueError:
        return False


def get_temperature() -> float:
    """
    Finds the temperature at time of reading.

    Returns:
        float: temperature in Fahrenheit, or -999.0 if unavailable
    """
    try:
        tw_reading = ht.get(WEATHER_URL)
        return float(tw_reading.json()["current"]["temperature_2m"])
    except ht.RequestError as e:
        print(f"Weather API request failed: {e}")
        return -999.0


def get_weather() -> str:
    """
    Finds the weather condition at time of reading.

    Returns:
        str: weather description e.g. "clear", "snow"
    """
    try:
        tw_reading = ht.get(WEATHER_URL)
        weather_code = tw_reading.json()["current"]["weathercode"]
        return WEATHER_CODES.get(weather_code, "unknown")
    except ht.RequestError as e:
        print(f"Weather API request failed: {e}")
        return "unavailable"


def get_month() -> int:
    """Gets the month at time of pull as 1-12."""
    return datetime.now().month


def get_year() -> int:
    """Gets the year at time of pull."""
    return datetime.now().year


def get_day_of_week() -> str:
    """Gets the day of the week e.g. Monday, Friday."""
    return datetime.now().strftime("%A")


def get_is_weekend() -> bool:
    """Returns True if current day is Saturday or Sunday."""
    return datetime.now().strftime("%A") in ("Saturday", "Sunday")


def get_season() -> str:
    """Gets the season at time of pull."""
    month = get_month()
    match month:
        case 12 | 1 | 2:
            return "Winter"
        case 3 | 4 | 5:
            return "Spring"
        case 6 | 7 | 8:
            return "Summer"
        case _:
            return "Autumn"


def get_term_info() -> dict:
    """
    Reads academic calendar from gym.db calendar table.
    Returns is_finals, is_break, academic_term.
    """
    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM calendar")
        rows = cursor.fetchall()

    calendar = {key: value for key, value in rows}

    is_finals = (
        _in_range(calendar.get("spring_finals", "99-99:99-99")) or
        _in_range(calendar.get("fall_finals",   "99-99:99-99"))
    )

    is_break = (
        _in_range(calendar.get("spring_break", "99-99:99-99")) or
        _in_range(calendar.get("fall_break",   "99-99:99-99"))
    )

    if _in_range(calendar.get("spring_classes", "99-99:99-99")):
        academic_term = "Spring 2026"
    elif _in_range(calendar.get("fall_classes", "99-99:99-99")):
        academic_term = "Fall 2025"
    elif _in_range(calendar.get("summer_classes", "99-99:99-99")):
        academic_term = "Summer 2026"
    else:
        academic_term = "Break"

    return {
        "is_finals":     is_finals,
        "is_break":      is_break,
        "academic_term": academic_term,
    }


def get_limited_hours() -> bool:
    """
    Checks if gym is running on limited hours schedule.
    Reads from calendar table in gym.db.
    """
    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM calendar WHERE key = ?", ("limited_hours",))
        row = cursor.fetchone()
    if row is None:
        return False
    return _in_range(row[0])


def get_context() -> dict:
    """
    Master function — returns all context metadata for a reading.
    Call once per poll in poller.py.
    """
    term = get_term_info()
    return {
        "temperature":   get_temperature(),
        "weather":       get_weather(),
        "season":        get_season(),
        "day_of_week":   get_day_of_week(),
        "month":         get_month(),
        "year":          get_year(),
        "is_weekend":    get_is_weekend(),
        "is_finals":     term["is_finals"] if term else False,
        "is_break":      term["is_break"] if term else False,
        "academic_term": term["academic_term"] if term else "Unknown",
        "limited_hours": get_limited_hours() or False,
    }