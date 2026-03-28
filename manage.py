import sqlite3
from datetime import datetime
import db

DB_PATH = "data/gym.db"

# Pre-populated from 2025-2026 Academic Calendar PDF
# Format: "MM-DD:MM-DD" (start:end), no year needed
DEFAULTS = {
    "fall_classes":        ("09-03:12-14", "Fall 2025 class dates"),
    "fall_finals":         ("12-08:12-14", "Fall 2025 final exam period"),
    "fall_break":          ("11-26:11-30", "Fall 2025 break"),
    "spring_classes":      ("01-07:04-19", "Spring 2026 class dates"),
    "spring_finals":       ("04-20:04-26", "Spring 2026 final exam period"),
    "spring_break":        ("03-02:03-08", "Spring 2026 break"),
    "summer_classes":      ("05-06:08-16", "Summer 2026 class dates"),
    "limited_hours":       ("05-06:09-02", "Summer reduced gym hours"),
    "fall_2026_start":     ("09-09:09-09", "Fall 2026 first day of classes"),
}


def seed_defaults() -> None:
    """
    Populates calendar table with default dates on first run.
    Uses INSERT OR IGNORE so existing data is never overwritten.
    """
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        for key, (value, description) in DEFAULTS.items():
            cursor.execute("""
                INSERT OR IGNORE INTO calendar (key, value, description)
                VALUES (?, ?, ?)
            """, (key, value, description))
        conn.commit()
    print("Default dates seeded.")


def show_dates() -> list[tuple]:
    """Prints all calendar entries in a numbered list."""
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value, description FROM calendar ORDER BY key")
        rows = cursor.fetchall()

    print("\nAcademic Calendar Manager")
    print("─" * 50)
    for i, (key, value, description) in enumerate(rows, 1):
        print(f"  {i}. {key:<22} {value:<20} {description}")
    print()
    return rows


def update_date(key: str, new_value: str) -> None:
    """
    Updates a calendar entry by key.
    Validates MM-DD:MM-DD format before writing.

    Args:
        key:       calendar key e.g. "spring_finals"
        new_value: date range in MM-DD:MM-DD format
    """
    # validate format
    try:
        parts = new_value.split(":")
        if len(parts) != 2:
            raise ValueError
        for part in parts:
            datetime.strptime(part, "%m-%d")
    except ValueError:
        print(f"Invalid format: '{new_value}'. Use MM-DD:MM-DD e.g. 04-20:04-26")
        return

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE calendar SET value = ? WHERE key = ?
        """, (new_value, key))
        conn.commit()
    print(f"Updated {key} to {new_value}")

def _in_range(value: str) -> bool:
    """
    Checks if today falls within a MM-DD:MM-DD range.
    Leading underscore means internal/private — not meant to be called outside this file.
    """
    start, end = value.split(":")
    today = datetime.now().strftime("%m-%d")
    return start <= today <= end

def get_limited_hours() -> bool:
    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM calendar WHERE key = ?", ("limited_hours",))
        row = cursor.fetchone()
    if row is None:
        return False
    return _in_range(row[0])


def main() -> None:
    """Main CLI loop."""
    db.init_db()
    seed_defaults()

    while True:
        rows = show_dates()
        choice = input("Select number to update (or q to quit): ").strip()

        if choice.lower() == "q":
            print("Exiting.")
            break

        try:
            index = int(choice) - 1
            if index < 0 or index >= len(rows):
                raise ValueError
        except ValueError:
            print("Invalid selection. Enter a number from the list or q.")
            continue

        key = rows[index][0]
        current = rows[index][1]
        print(f"Current value for {key}: {current}")
        new_value = input(f"Enter new date range (MM-DD:MM-DD): ").strip()
        update_date(key, new_value)

def get_term_info() -> dict:
    """
    Reads calendar table and returns academic term context.

    Returns:
        dict with keys: is_finals, is_break, academic_term
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


if __name__ == "__main__":
    main()

