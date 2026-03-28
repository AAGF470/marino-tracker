import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import httpx as ht
from datetime import datetime, timezone
import time
import db
import context


#Responsible for Data collection
#TODO: persist last_polled dict to file on interval for crash recovery

last_polled: dict[str, datetime] = {}
polled_at: datetime = datetime.min


def commit_reading(room_name: str, count: int, capacity: int, is_closed: bool,
                   last_updated: datetime, polled_at: datetime, facility: str) -> None:
    """
    Writes to live table always.
    Writes to historical table with full context.

    Args:
        room_name:    name of the room
        count:        current headcount
        capacity:     maximum capacity
        is_closed:    whether the room is closed
        last_updated: timestamp from the API
        polled_at:    timestamp when poller fetched the data
        facility:     "marino" or "squash"
    """
    db.write_live(
        facility=facility,
        room_name=room_name,
        count=count,
        capacity=capacity,
        is_closed=is_closed,
        last_updated=last_updated,
        polled_at=polled_at
    )

    ctx = context.get_context()

    db.write_historical(
        facility=facility,
        room_name=room_name,
        count=count,
        capacity=capacity,
        is_closed=is_closed,
        last_updated=last_updated,
        polled_at=polled_at,
        day_of_week=ctx["day_of_week"],
        month=ctx["month"],
        year=ctx["year"],
        season=ctx["season"],
        is_weekend=ctx["is_weekend"],
        is_finals=ctx["is_finals"],
        is_break=ctx["is_break"],
        academic_term=ctx["academic_term"],
        weather=ctx["weather"],
        limited_hours=ctx["limited_hours"],
        temperature=ctx["temperature"]
    )


def save_reading(room_name: str, count: int, capacity: int, is_closed: bool,
                 last_updated: datetime, polled_at: datetime, facility: str) -> None:
    """
    Gap check — only commits if enough time has passed since last poll.

    Args:
        room_name:    name of the room
        count:        current headcount
        capacity:     maximum capacity
        is_closed:    whether the room is closed
        last_updated: timestamp from the API
        polled_at:    timestamp when poller fetched the data
        facility:     "marino" or "squash"
    """
    last = last_polled.get(room_name)

    if last is not None:
        gap = (polled_at - last).total_seconds() / 60
        if gap < 4:
            return

    last_polled[room_name] = polled_at
    commit_reading(room_name, count, capacity, is_closed, last_updated, polled_at, facility)


def format_location(location: dict) -> None:
    """
    Reformats the LocationId to a readable room name and routes to save_reading.

    Args:
        location: raw location dict from Connect2 API
    """
    match location["LocationId"]:
        case 11143:
            room_name = "Marino Center 2nd Floor Cardio and Weights"
            facility  = "marino"
        case 7093:
            room_name = "Marino Center 3rd Floor Weight Room"
            facility  = "marino"
        case 7092:
            room_name = "Marino Center 3rd Floor Cardio and Machined Weight Area"
            facility  = "marino"
        case 11444:
            room_name = "Marino Center 1st Floor Weight Room"
            facility  = "marino"
        case 1876:
            room_name = "Marino Center Gym"
            facility  = "marino"
        case 9531:
            room_name = "Marino Center Studio A"
            facility  = "marino"
        case 9532:
            room_name = "Marino Center Studio B"
            facility  = "marino"
        case 6522:
            room_name = "SquashBusters 4th Floor"
            facility  = "squash"
        case _:
            print("There may be an un-added room facility")
            return

    save_reading(
        room_name=room_name,
        count=location["LastCount"],
        capacity=location["TotalCapacity"],
        is_closed=location["IsClosed"],
        last_updated=datetime.fromisoformat(location["LastUpdatedDateAndTime"]),
        polled_at=polled_at,
        facility=facility
    )


def update() -> None:
    """
    Fetches API data and processes each location.
    """
    global polled_at
    try:
        pulled_data = ht.get('https://goboardapi.azurewebsites.net/api/FacilityCount/GetCountsByAccount?AccountAPIKey=2a2be0d8-df10-4a48-bedd-b3bc0cd628e7')
        print(pulled_data.status_code)
        refined_pull = pulled_data.json()
        polled_at = datetime.now(timezone.utc)

        for location in refined_pull:
            format_location(location)

    except ht.RequestError as e:
        print(f'Request Failed: {e}')
    except ht.HTTPStatusError as e:
        print(f'Bad Status Code: {e}')


db.init_db()

while True:
    update()
    print("Sleeping 5 minutes...")
    time.sleep(300)