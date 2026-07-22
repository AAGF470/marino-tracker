import sqlite3
import math
import time
import argparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import db
import context

# Responsible for occupancy forecasting.
#
# Algorithm: recency-weighted weekly seasonal baseline + live residual correction.
#
#   1. Every historical reading is bucketed into a 15-minute slot of the week
#      (Monday 00:00 ET = slot 0 ... Sunday 23:45 ET = slot 671). Slots are
#      derived from polled_at converted to America/New_York — the stored
#      day_of_week column is server-local (UTC) and shifts for ET evenings.
#   2. The baseline for each (room, slot) is a weighted mean of readings in
#      that slot. Weights decay exponentially with age (half-life 21 days) and
#      are penalized when the reading's schedule regime (limited_hours,
#      is_break, is_finals) doesn't match the current regime.
#   3. Baselines are smoothed across adjacent slots to reduce poll noise.
#   4. The next few hours are corrected by how today is actually going: the
#      ratio of the last 90 minutes of actuals vs the baseline, decaying back
#      to the pure baseline over the forecast horizon.
#
# Closed rooms report stale counts, so is_closed readings count as 0 occupancy.
#
# The NEU counter also freezes overnight and during outages: polled_at keeps
# advancing while last_updated (naive ET) does not, leaving stale counts in the
# data. Readings whose sensor timestamp lags the poll by more than
# STALE_MINUTES are excluded from training and live correction. Slots left with
# no trustworthy data (overnight) fall back to 0, which matches a closed gym.

TZ = ZoneInfo("America/New_York")

SLOT_MINUTES     = 15                     # forecast resolution
SLOTS_PER_DAY    = 24 * 60 // SLOT_MINUTES
SLOTS_PER_WEEK   = 7 * SLOTS_PER_DAY
HALF_LIFE_DAYS   = 21                     # recency decay half-life
HISTORY_DAYS     = 120                    # how far back to train on
HORIZON_HOURS    = 24                     # how far ahead to predict
LOOKBACK_MINUTES = 90                     # window of actuals for live correction
CORRECTION_TAU   = 120                    # minutes for correction to decay ~63%
STALE_MINUTES    = 90                     # sensor lag beyond this = untrustworthy
MODEL_VERSION    = 1

# Ultra-quiet: few enough people to be barely noticeable in the room.
ULTRA_QUIET_FRACTION = 0.08               # of capacity, floor of 2 people
ULTRA_QUIET_MARGIN   = 0.75               # predictions must clear thr×margin —
                                          # backtested: lifts window precision to ~90%
OPEN_LOOKBACK_DAYS   = 28                 # window for inferring open hours
OPEN_MIN_FRESH       = 4                  # fresh readings needed to call a slot open
MIN_WINDOW_SLOTS     = 2                  # ignore ultra-quiet blips under 30 min

FACILITIES = ("marino", "squash")


def week_slot(dt_et: datetime) -> int:
    """
    Maps an ET datetime to its 15-minute slot of the week.

    Args:
        dt_et: timezone-aware datetime in America/New_York
    Returns:
        int: 0 (Mon 00:00) through SLOTS_PER_WEEK - 1 (Sun 23:45)
    """
    return dt_et.weekday() * SLOTS_PER_DAY + dt_et.hour * (60 // SLOT_MINUTES) + dt_et.minute // SLOT_MINUTES


def regime_weight(row_limited: int, row_break: int, row_finals: int,
                  now_limited: bool, now_break: bool, now_finals: bool) -> float:
    """
    Downweights readings taken under a different schedule regime.

    Args:
        row_limited: reading's limited_hours flag
        row_break:   reading's is_break flag
        row_finals:  reading's is_finals flag
        now_limited: current limited_hours state
        now_break:   current is_break state
        now_finals:  current is_finals state
    Returns:
        float: multiplier in (0, 1]
    """
    weight = 1.0
    if bool(row_limited) != now_limited:
        weight *= 0.15
    if bool(row_break) != now_break:
        weight *= 0.3
    if bool(row_finals) != now_finals:
        weight *= 0.5
    return weight


def is_stale(last_updated: str, polled_at_utc: datetime) -> bool:
    """
    Detects frozen sensor readings.

    Args:
        last_updated:  sensor timestamp from the API — naive, in ET
        polled_at_utc: timezone-aware poll time
    Returns:
        bool: True if the sensor lagged the poll by more than STALE_MINUTES
    """
    try:
        lu = datetime.fromisoformat(last_updated).replace(tzinfo=TZ)
    except (ValueError, TypeError):
        return True
    return (polled_at_utc - lu).total_seconds() / 60 > STALE_MINUTES


def load_history(now_utc: datetime) -> list[tuple]:
    """
    Loads training rows from both historical tables.

    Args:
        now_utc: current time, used to bound the training window
    Returns:
        list of (room_name, count, is_closed, last_updated, polled_at,
                 limited_hours, is_break, is_finals) tuples
    """
    since = (now_utc - timedelta(days=HISTORY_DAYS)).isoformat()
    rows = []
    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()
        for facility in FACILITIES:
            cursor.execute(f"""
                SELECT room_name, count, is_closed, last_updated, polled_at,
                       limited_hours, is_break, is_finals
                FROM {facility}_historical
                WHERE polled_at >= ?
            """, (since,))
            rows.extend(cursor.fetchall())
    return rows


def get_capacities() -> dict[str, int]:
    """Returns current capacity per room from the live tables."""
    capacities = {}
    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()
        for facility in FACILITIES:
            cursor.execute(f"SELECT room_name, capacity FROM {facility}_live")
            for room_name, capacity in cursor.fetchall():
                capacities[room_name] = capacity or 0
    return capacities


def build_baselines(rows: list[tuple], now_utc: datetime,
                    now_limited: bool, now_break: bool, now_finals: bool) -> dict[str, list[float]]:
    """
    Builds the weighted weekly baseline curve for every room.

    Args:
        rows:        output of load_history
        now_utc:     current time, for age weighting
        now_limited: current limited_hours state
        now_break:   current is_break state
        now_finals:  current is_finals state
    Returns:
        dict: room_name -> list of SLOTS_PER_WEEK baseline counts
    """
    sums:    dict[str, list[float]] = {}
    weights: dict[str, list[float]] = {}

    for room_name, count, is_closed, last_updated, polled_at, limited, brk, finals in rows:
        try:
            dt = datetime.fromisoformat(polled_at)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)

        if not is_closed and is_stale(last_updated, dt):
            continue

        slot = week_slot(dt.astimezone(TZ))
        age_days = (now_utc - dt).total_seconds() / 86400
        weight = 0.5 ** (age_days / HALF_LIFE_DAYS)
        weight *= regime_weight(limited, brk, finals, now_limited, now_break, now_finals)

        value = 0.0 if is_closed else float(count or 0)

        if room_name not in sums:
            sums[room_name]    = [0.0] * SLOTS_PER_WEEK
            weights[room_name] = [0.0] * SLOTS_PER_WEEK
        sums[room_name][slot]    += value * weight
        weights[room_name][slot] += weight

    baselines = {}
    for room_name in sums:
        raw = [sums[room_name][s] / weights[room_name][s] if weights[room_name][s] > 0 else 0.0
               for s in range(SLOTS_PER_WEEK)]
        baselines[room_name] = smooth(raw)
    return baselines


def smooth(curve: list[float]) -> list[float]:
    """
    Applies a [0.25, 0.5, 0.25] kernel across adjacent slots (wrapping).

    Args:
        curve: raw per-slot values
    Returns:
        list: smoothed values, same length
    """
    n = len(curve)
    return [0.25 * curve[(i - 1) % n] + 0.5 * curve[i] + 0.25 * curve[(i + 1) % n]
            for i in range(n)]


def live_correction(room_name: str, baseline: list[float], now_utc: datetime) -> float:
    """
    Compares recent actuals against the baseline to see how today is trending.

    Args:
        room_name: room to check
        baseline:  the room's weekly baseline curve
        now_utc:   current time
    Returns:
        float: ratio of actual to expected, clipped to [0.6, 1.7];
               1.0 when there isn't enough signal (overnight, no recent polls)
    """
    since = (now_utc - timedelta(minutes=LOOKBACK_MINUTES)).isoformat()
    actual_sum = 0.0
    expected_sum = 0.0

    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()
        for facility in FACILITIES:
            cursor.execute(f"""
                SELECT count, is_closed, last_updated, polled_at
                FROM {facility}_historical
                WHERE room_name = ? AND polled_at >= ?
            """, (room_name, since))
            for count, is_closed, last_updated, polled_at in cursor.fetchall():
                dt = datetime.fromisoformat(polled_at)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if not is_closed and is_stale(last_updated, dt):
                    continue
                actual_sum   += 0.0 if is_closed else float(count or 0)
                expected_sum += baseline[week_slot(dt.astimezone(TZ))]

    # too little expected traffic to form a meaningful ratio (e.g. overnight)
    if expected_sum < 5.0:
        return 1.0
    return max(0.6, min(1.7, actual_sum / expected_sum))


def ultra_quiet_threshold(capacity: int) -> int:
    """
    Headcount at or below which a room feels effectively empty.

    Args:
        capacity: room capacity
    Returns:
        int: threshold in people, minimum 2
    """
    return max(2, round(ULTRA_QUIET_FRACTION * capacity))


def build_openness(rows: list[tuple], now_utc: datetime) -> dict[str, list[bool]]:
    """
    Infers per-room open hours from the data: a slot counts as open if the
    sensor produced fresh readings there recently. There is no authoritative
    hours source — the counter freezing IS the closed signal.

    Args:
        rows:    output of load_history
        now_utc: current time
    Returns:
        dict: room_name -> list of SLOTS_PER_WEEK booleans
    """
    fresh: dict[str, list[int]] = {}
    cutoff = now_utc - timedelta(days=OPEN_LOOKBACK_DAYS)

    for room_name, count, is_closed, last_updated, polled_at, *_ in rows:
        try:
            dt = datetime.fromisoformat(polled_at)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if dt < cutoff or is_closed or is_stale(last_updated, dt):
            continue

        if room_name not in fresh:
            fresh[room_name] = [0] * SLOTS_PER_WEEK
        fresh[room_name][week_slot(dt.astimezone(TZ))] += 1

    return {room: [c >= OPEN_MIN_FRESH for c in counts]
            for room, counts in fresh.items()}


def collapse_windows(flags: list[bool]) -> list[tuple[int, int]]:
    """
    Groups consecutive flagged positions into (start, end_exclusive) runs,
    dropping runs shorter than MIN_WINDOW_SLOTS.

    Args:
        flags: one boolean per slot/step
    Returns:
        list of (start_index, end_index_exclusive) tuples
    """
    windows = []
    start = None
    for i, flagged in enumerate([*flags, False]):
        if flagged and start is None:
            start = i
        elif not flagged and start is not None:
            if i - start >= MIN_WINDOW_SLOTS:
                windows.append((start, i))
            start = None
    return windows


def slot_label(slot: int) -> tuple[str, str]:
    """
    Maps a week slot back to human-readable ET day and time.

    Args:
        slot: 0 (Mon 00:00) through SLOTS_PER_WEEK - 1 (Sun 23:45)
    Returns:
        tuple: (day_of_week e.g. "Wednesday", time_of_day e.g. "08:00")
    """
    days = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    minutes = (slot % SLOTS_PER_DAY) * SLOT_MINUTES
    return days[slot // SLOTS_PER_DAY], f"{minutes // 60:02d}:{minutes % 60:02d}"


def write_baselines(cursor: sqlite3.Cursor, baselines: dict[str, list[float]],
                    capacities: dict[str, int], generated_at: str) -> int:
    """
    Persists the full weekly baseline curve so any day/time can be queried,
    not just the next 24 hours. Replaces the previous generation.

    Args:
        cursor:       open cursor on gym.db
        baselines:    output of build_baselines
        capacities:   current capacity per room
        generated_at: generation timestamp shared with the forecast
    Returns:
        int: number of baseline rows written
    """
    written = 0
    for facility in FACILITIES:
        table = f"{facility}_baseline"
        cursor.execute(f"DELETE FROM {table}")

        for room_name, baseline in baselines.items():
            if (facility == "squash") != room_name.startswith("SquashBusters"):
                continue

            capacity = capacities.get(room_name, 0)
            for slot in range(SLOTS_PER_WEEK):
                value = baseline[slot]
                if capacity > 0:
                    value = min(value, capacity)
                day_of_week, time_of_day = slot_label(slot)

                cursor.execute(f"""
                    INSERT INTO {table}
                    (room_name, slot, day_of_week, time_of_day,
                     predicted_count, generated_at, model_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (room_name, slot, day_of_week, time_of_day,
                      max(0, round(value)), generated_at, MODEL_VERSION))
                written += 1
    return written


def write_quiet_windows(cursor: sqlite3.Cursor, baselines: dict[str, list[float]],
                        openness: dict[str, list[bool]], capacities: dict[str, int],
                        forecast_points: dict[str, list[tuple]], generated_at: str) -> int:
    """
    Finds and stores ultra-quiet windows: stretches where a room is open but
    predicted to hold no more than its ultra-quiet threshold.
    Writes two kinds — 'next24' (UTC timestamps, from the live forecast) and
    'typical' (ET day + times, from the weekly baseline).

    Args:
        cursor:          open cursor on gym.db
        baselines:       output of build_baselines
        openness:        output of build_openness
        capacities:      current capacity per room
        forecast_points: room_name -> [(time_et, predicted_count, slot)] from
                         the forecast generation loop
        generated_at:    generation timestamp
    Returns:
        int: number of windows written
    """
    cursor.execute("DELETE FROM quiet_windows")
    written = 0

    for room_name, baseline in baselines.items():
        open_slots = openness.get(room_name)
        if open_slots is None:
            continue
        capacity = capacities.get(room_name, 0)
        threshold = ultra_quiet_threshold(capacity)
        flag_bar = max(1, round(threshold * ULTRA_QUIET_MARGIN))

        # typical week — evaluate day by day so windows don't cross midnight
        for day_index in range(7):
            flags = []
            for s in range(day_index * SLOTS_PER_DAY, (day_index + 1) * SLOTS_PER_DAY):
                value = min(baseline[s], capacity) if capacity > 0 else baseline[s]
                flags.append(open_slots[s] and round(value) <= flag_bar)

            for start, end in collapse_windows(flags):
                day_name, start_time = slot_label(day_index * SLOTS_PER_DAY + start)
                end_minutes = end * SLOT_MINUTES
                end_time = "23:59" if end_minutes >= 1440 else f"{end_minutes // 60:02d}:{end_minutes % 60:02d}"
                cursor.execute("""
                    INSERT INTO quiet_windows
                    (room_name, kind, day_of_week, start_time, end_time,
                     generated_at, model_version)
                    VALUES (?, 'typical', ?, ?, ?, ?, ?)
                """, (room_name, day_name, start_time, end_time,
                      generated_at, MODEL_VERSION))
                written += 1

        # next 24 hours — from the live forecast, which includes the correction
        points = forecast_points.get(room_name, [])
        flags = [open_slots[slot] and count <= flag_bar for _, count, slot in points]
        for start, end in collapse_windows(flags):
            window_end = points[end - 1][0] + timedelta(minutes=SLOT_MINUTES)
            cursor.execute("""
                INSERT INTO quiet_windows
                (room_name, kind, day_of_week, start_time, end_time,
                 generated_at, model_version)
                VALUES (?, 'next24', NULL, ?, ?, ?, ?)
            """, (room_name, points[start][0].astimezone(timezone.utc).isoformat(),
                  window_end.astimezone(timezone.utc).isoformat(),
                  generated_at, MODEL_VERSION))
            written += 1

    return written


def generate_forecast(now_utc: datetime | None = None) -> int:
    """
    Regenerates the full forecast for every room and writes it to the
    forecast tables, replacing the previous generation.

    Args:
        now_utc: override for testing; defaults to the current time
    Returns:
        int: number of prediction rows written
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)

    ctx = context.get_context()
    rows = load_history(now_utc)
    if not rows:
        print("No historical data — skipping forecast.")
        return 0

    baselines = build_baselines(rows, now_utc,
                                ctx["limited_hours"], ctx["is_break"], ctx["is_finals"])
    openness = build_openness(rows, now_utc)
    capacities = get_capacities()
    generated_at = now_utc.isoformat()

    # align the first prediction to the next slot boundary
    now_et = now_utc.astimezone(TZ)
    start = now_et.replace(minute=(now_et.minute // SLOT_MINUTES) * SLOT_MINUTES,
                           second=0, microsecond=0) + timedelta(minutes=SLOT_MINUTES)
    steps = HORIZON_HOURS * 60 // SLOT_MINUTES

    written = 0
    forecast_points: dict[str, list[tuple]] = {}
    with sqlite3.connect(db.DB_PATH) as conn:
        cursor = conn.cursor()

        baseline_rows = write_baselines(cursor, baselines, capacities, generated_at)

        for facility in FACILITIES:
            table = f"{facility}_forecast"
            cursor.execute(f"DELETE FROM {table}")

            for room_name, baseline in baselines.items():
                if (facility == "squash") != room_name.startswith("SquashBusters"):
                    continue

                ratio = live_correction(room_name, baseline, now_utc)
                capacity = capacities.get(room_name, 0)
                forecast_points[room_name] = []

                for i in range(steps):
                    t = start + timedelta(minutes=i * SLOT_MINUTES)
                    minutes_ahead = (t - now_et).total_seconds() / 60
                    decay = math.exp(-minutes_ahead / CORRECTION_TAU)
                    predicted = baseline[week_slot(t)] * (1 + (ratio - 1) * decay)

                    if capacity > 0:
                        predicted = min(predicted, capacity)
                    predicted_count = max(0, round(predicted))

                    cursor.execute(f"""
                        INSERT INTO {table}
                        (room_name, predicted_time, predicted_count, generated_at, model_version)
                        VALUES (?, ?, ?, ?, ?)
                    """, (room_name, t.astimezone(timezone.utc).isoformat(),
                          predicted_count, generated_at, MODEL_VERSION))
                    forecast_points[room_name].append((t, predicted_count, week_slot(t)))
                    written += 1

        windows = write_quiet_windows(cursor, baselines, openness, capacities,
                                      forecast_points, generated_at)
        conn.commit()

    print(f"Forecast generated: {written} forecast + {baseline_rows} baseline rows "
          f"+ {windows} quiet windows at {generated_at}")
    return written


def main() -> None:
    """CLI — run once by default, or loop forever with --loop."""
    parser = argparse.ArgumentParser(description="Marino Tracker occupancy forecaster")
    parser.add_argument("--loop", action="store_true", help="regenerate every 30 minutes")
    args = parser.parse_args()

    db.init_db()

    if not args.loop:
        generate_forecast()
        return

    while True:
        try:
            generate_forecast()
        except Exception as e:
            print(f"Forecast generation failed: {e}")
        print("Sleeping 30 minutes...")
        time.sleep(1800)


if __name__ == "__main__":
    main()
