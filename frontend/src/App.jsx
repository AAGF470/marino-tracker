import { useState, useEffect, useRef, useMemo } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Marino Tracker — live + historical NEU gym occupancy.
//
// Self-contained: React only, no component-library dependency. Visual language
// is "frosted glass / Framer" — glass panels (see .glass in index.css) over an
// aurora backdrop. Data comes from the same API as before:
//   GET /api/live                       → current occupancy per room
//   GET /api/history?days=N             → per-poll history rows
//   GET /api/forecast                   → next-24h predictions per room
// The 90-day history is ~40MB, so the dashboard aggregates a small recent
// window for its charts and only pulls the full 90 days on the download click.
// ─────────────────────────────────────────────────────────────────────────────

const API           = 'https://gym-api.cryark.net'
const HISTORY_DAYS   = 14   // window fetched for the weekly/hourly aggregates
const DOWNLOAD_DAYS  = 90   // full export on the download button
const LIVE_REFRESH   = 300000 // 5 min

// ─── palette (JS mirror of index.css vars, for SVG/canvas colors) ────────────
const C = {
  teal: '#3ddfa9', blue: '#5aa2ff', violet: '#9b8cff', amber: '#eab766', red: '#f06a76',
  cyan: '#7dd3fc',
  text: '#eef1f7', sub: '#99a1b3', dim: '#5d6478', line: 'rgba(255,255,255,0.07)',
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const pctOf   = r => (r.capacity > 0 ? (r.count / r.capacity) * 100 : 0)
const isSquash = name => name.includes('SquashBusters')
const clean = name => name.replace('Marino Center ', '').replace('SquashBusters ', '')
const short = name => name.replace('Marino Center ', '').replace('SquashBusters ', 'SB ')

function band(pct) {
  if (pct < 30) return { label: 'QUIET',    c: C.teal }
  if (pct < 60) return { label: 'MODERATE', c: C.blue }
  if (pct < 85) return { label: 'BUSY',     c: C.amber }
  return              { label: 'PACKED',   c: C.red }
}

// Ultra-quiet: absolute headcount low enough to be barely noticeable in the
// room — max(2, 8% of capacity), same formula as predictor.py serves via
// /api/quiet. Sits below QUIET and only applies where we know actual people.
const ultraThreshold = capacity => Math.max(2, Math.round(0.08 * capacity))

function bandCount(count, capacity) {
  if (capacity > 0 && count <= ultraThreshold(capacity))
    return { label: 'ULTRA QUIET', c: C.cyan, ultra: true }
  return band(capacity > 0 ? (count / capacity) * 100 : 0)
}

const hourLabel = h => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`
const DOW       = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DOW_SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' }

function matchRoom(name, sel) {
  if (sel === 'all')        return true
  if (sel === 'fac:squash') return isSquash(name)
  if (sel === 'fac:marino') return !isSquash(name)
  return name === sel
}

// ─── aggregation (client-side over the recent window) ────────────────────────
function weeklyAverages(history, sel) {
  const buckets = Object.fromEntries(DOW.map(d => [d, []]))
  for (const r of history) {
    if (!matchRoom(r.room_name, sel)) continue
    if (buckets[r.day_of_week]) buckets[r.day_of_week].push(pctOf(r))
  }
  return DOW.map(d => {
    const a = buckets[d]
    return { day: d, short: DOW_SHORT[d], pct: a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0, n: a.length }
  })
}

function hourlyAverages(history, sel) {
  const buckets = Array.from({ length: 24 }, () => [])
  for (const r of history) {
    if (!matchRoom(r.room_name, sel)) continue
    const h = new Date(r.polled_at).getHours()
    if (!Number.isNaN(h)) buckets[h].push(pctOf(r))
  }
  return buckets.map((a, hour) => ({ hour, pct: a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0, n: a.length }))
}

function summarize(history, sel) {
  const w = weeklyAverages(history, sel)
  const h = hourlyAverages(history, sel)
  const busiestDay = w.reduce((m, x) => (x.pct > m.pct ? x : m), w[0])
  const open = h.filter(x => x.n > 0 && x.pct > 1.5)
  const busiestHour = open.reduce((m, x) => (x.pct > m.pct ? x : m), open[0] || { hour: 0, pct: 0 })
  const quietHour   = open.reduce((m, x) => (x.pct < m.pct ? x : m), open[0] || { hour: 0, pct: 0 })
  const vals = history.filter(r => matchRoom(r.room_name, sel)).map(pctOf)
  const avg = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0
  return { busiestDay, busiestHour, quietHour, avg, samples: vals.length }
}

// forecast rows → averaged % full per timestamp for the current selection
function forecastSeries(forecast, sel, caps) {
  const byTime = new Map()
  for (const r of forecast) {
    if (!matchRoom(r.room_name, sel)) continue
    const cap = caps[r.room_name]
    if (!cap) continue
    if (!byTime.has(r.predicted_time)) byTime.set(r.predicted_time, [])
    byTime.get(r.predicted_time).push((r.predicted_count / cap) * 100)
  }
  return [...byTime.entries()]
    .map(([t, a]) => ({ t: new Date(t), pct: a.reduce((s, x) => s + x, 0) / a.length }))
    .sort((a, b) => a.t - b.t)
}

// baseline rows → one day's typical curve for the current selection
function baselineDay(baseline, sel, day, caps) {
  const byTime = new Map()
  for (const r of baseline) {
    if (r.day_of_week !== day) continue
    if (!matchRoom(r.room_name, sel)) continue
    const cap = caps[r.room_name]
    if (!cap) continue
    if (!byTime.has(r.time_of_day)) byTime.set(r.time_of_day, { pcts: [], people: 0 })
    const b = byTime.get(r.time_of_day)
    b.pcts.push((r.predicted_count / cap) * 100)
    b.people += r.predicted_count
  }
  return [...byTime.entries()]
    .map(([time, b]) => ({ time, pct: b.pcts.reduce((s, x) => s + x, 0) / b.pcts.length, people: b.people }))
    .sort((a, b) => a.time.localeCompare(b.time))
}

// ─── CSV export ──────────────────────────────────────────────────────────────
function toCSV(rows) {
  const cols = ['room_name', 'count', 'capacity', 'pct_full', 'polled_at', 'day_of_week', 'temperature', 'weather', 'academic_term']
  const esc = v => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = rows.map(r => {
    const pct = r.capacity > 0 ? Math.round((r.count / r.capacity) * 100) : ''
    return [r.room_name, r.count, r.capacity, pct, r.polled_at, r.day_of_week, r.temperature, r.weather, r.academic_term].map(esc).join(',')
  })
  return [cols.join(','), ...body].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared UI atoms
// ─────────────────────────────────────────────────────────────────────────────
const label = { fontFamily: 'var(--display)', fontSize: 10.5, letterSpacing: 1.6, fontWeight: 600, textTransform: 'uppercase' }

function SectionLabel({ children, accent = C.teal }) {
  return (
    <div style={{ ...label, color: accent, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
      {children}
      <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, var(--line), transparent)' }} />
    </div>
  )
}

function RoomSelect({ rooms, value, onChange }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="all">All rooms</option>
      <option value="fac:marino">Marino — all rooms</option>
      <option value="fac:squash">SquashBusters — all rooms</option>
      <optgroup label="Individual rooms">
        {rooms.map(r => <option key={r} value={r}>{clean(r)}</option>)}
      </optgroup>
    </select>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar — brand, always-visible live gauge, view navigation, CSV download.
// Collapses to a sticky top bar with horizontal tabs on ≤880px (index.css).
// ─────────────────────────────────────────────────────────────────────────────
const NAV_ICONS = {
  live:     <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3.5" />,
  forecast: <path d="M1.5 12.5l4-5 3 3 6-7.5M11 3h3.5v3.5" />,
  planner:  <><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></>,
  history:  <><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5V8l2.5 1.5" /></>,
}

const VIEWS = [
  ['live',     'Live'],
  ['forecast', 'Forecast'],
  ['planner',  'Plan a visit'],
  ['history',  'History'],
]

function NavIcon({ name }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {NAV_ICONS[name]}
    </svg>
  )
}

function Sidebar({ live, lastUpdate, view, setView, onDownload, dlState }) {
  const active = live.filter(r => !r.is_closed && r.capacity > 0)
  const overall = active.length ? active.reduce((s, r) => s + pctOf(r), 0) / active.length : 0
  const totalPeople = live.reduce((s, r) => s + (r.count || 0), 0)
  const b = band(overall)

  return (
    <aside className="sidebar">
      {/* brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
        <a href="https://cryark.net/home/" target="_blank" rel="noreferrer" style={{ display: 'flex' }}>
          <img src="https://cryark.net/wp-content/uploads/2026/01/CRYARK-scaled.png" alt="CRYARK"
            style={{ height: 20, objectFit: 'contain' }} onError={e => { e.target.style.display = 'none' }} />
        </a>
        <span style={{ ...label, fontSize: 10.5, color: C.text, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.teal }} />
          MARINO TRACKER
        </span>
      </div>

      {/* live gauge — always visible on desktop */}
      <div className="side-gauge glass" style={{ padding: '14px 16px' }}>
        <div style={{ ...label, fontSize: 9, color: C.sub, marginBottom: 8 }}>Right now</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 600, lineHeight: 1, color: C.text }}>
            {live.length ? Math.round(overall) : '—'}<span style={{ fontSize: 13, color: C.sub }}>%</span>
          </span>
          <span style={{ ...label, fontSize: 9.5, color: b.c }}>{live.length ? b.label : ''}</span>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: C.dim, marginTop: 7 }}>
          {totalPeople} people · {active.length} open
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: C.dim, marginTop: 3 }}>
          {lastUpdate ? `updated ${lastUpdate}` : 'connecting…'}
        </div>
      </div>

      {/* views */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {VIEWS.map(([key, name]) => (
          <button key={key} className={`nav-btn${view === key ? ' active' : ''}`} onClick={() => setView(key)}>
            <NavIcon name={key} />
            {name}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      {/* CSV export */}
      <button className="side-download nav-btn" onClick={dlState === 'loading' ? undefined : onDownload}
        style={{ border: '1px solid var(--line)', color: dlState === 'done' ? C.teal : dlState === 'error' ? C.red : C.sub }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
        </svg>
        {{ idle: '90-day CSV', loading: 'Preparing…', done: 'Downloaded ✓', error: 'Failed — retry' }[dlState]}
      </button>

      <div className="side-credits" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: C.dim, lineHeight: 1.7, padding: '0 4px' }}>
        Data — NEU Recreation<br />
        <a href="https://guillensolutions.com" target="_blank" rel="noreferrer" style={{ color: C.sub, textDecoration: 'none' }}>
          Guillen Solutions ↗
        </a> · project by AG
      </div>
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// View header — title + context line at the top of each view
// ─────────────────────────────────────────────────────────────────────────────
function ViewHeader({ title, sub }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h1 style={{ fontFamily: 'var(--display)', fontSize: 'clamp(21px, 3vw, 26px)', fontWeight: 700, letterSpacing: -0.3 }}>
        {title}
      </h1>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: C.dim, marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Live occupancy card
// ─────────────────────────────────────────────────────────────────────────────
function OccupancyCard({ room, i }) {
  const pct  = room.capacity > 0 ? Math.round((room.count / room.capacity) * 100) : 0
  const b    = bandCount(room.count, room.capacity)
  const closed = room.is_closed
  const measured = room.last_updated
    ? new Date(room.last_updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div className="glass lift rise" style={{ padding: 20, animationDelay: `${i * 40}ms`, opacity: closed ? 0.5 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ ...label, fontSize: 9.5, color: closed ? C.dim : b.c }}>{closed ? 'CLOSED' : b.label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: C.dim }}>{measured}</span>
      </div>

      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, minHeight: 38, lineHeight: 1.3, marginBottom: 12 }}>
        {clean(room.room_name)}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 34, fontWeight: 600, lineHeight: 1, color: closed ? C.dim : C.text }}>
          {room.count}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: C.dim }}>/ {room.capacity}</span>
      </div>

      {/* progress track */}
      <div style={{ marginTop: 14, height: 3, borderRadius: 20, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
        <div style={{
          width: `${Math.min(pct, 100)}%`, height: '100%', borderRadius: 20,
          background: b.c, transition: 'width 1s cubic-bezier(.2,.7,.2,1)',
        }} />
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: C.dim, marginTop: 8 }}>{pct}% full</div>
    </div>
  )
}

function FacilityGroup({ title, rooms }) {
  if (!rooms.length) return null
  return (
    <div style={{ marginBottom: 28 }}>
      <SectionLabel accent={C.sub}>{title}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
        {rooms.map((room, i) => <OccupancyCard key={room.room_name} room={room} i={i} />)}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly averages — the headline diagram (replaces the raw time-series)
// ─────────────────────────────────────────────────────────────────────────────
function WeeklyChart({ history, rooms }) {
  const [sel, setSel] = useState('all')
  const [mounted, setMounted] = useState(false)
  const data = useMemo(() => weeklyAverages(history, sel), [history, sel])
  useEffect(() => { setMounted(false); const t = setTimeout(() => setMounted(true), 60); return () => clearTimeout(t) }, [sel, history])

  const maxPct = Math.max(10, ...data.map(d => d.pct))
  const axisMax = Math.ceil(maxPct / 10) * 10

  return (
    <div className="glass" style={{ padding: 'clamp(20px, 3vw, 30px)', marginBottom: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700 }}>Average by day of week</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim, marginTop: 5 }}>
            mean % full · last {HISTORY_DAYS} days
          </div>
        </div>
        <RoomSelect rooms={rooms} value={sel} onChange={setSel} />
      </div>

      {/* bars */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'clamp(6px, 1.5vw, 16px)', height: 200 }}>
        {data.map(d => {
          const b = band(d.pct)
          const hPct = mounted ? (d.pct / axisMax) * 100 : 0
          return (
            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
              <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                <div style={{ position: 'relative', width: '100%', maxWidth: 46, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                  {/* value label */}
                  <div style={{
                    position: 'absolute', bottom: `calc(${hPct}% + 6px)`, left: 0, right: 0, textAlign: 'center',
                    fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: b.c,
                    opacity: mounted ? 1 : 0, transition: 'opacity .5s .4s, bottom .8s cubic-bezier(.2,.7,.2,1)',
                  }}>{Math.round(d.pct)}%</div>
                  {/* bar */}
                  <div style={{
                    width: '100%', height: `${hPct}%`, minHeight: d.n ? 3 : 0, borderRadius: '6px 6px 3px 3px',
                    background: `${b.c}b8`, transition: 'height .8s cubic-bezier(.2,.7,.2,1)',
                  }} title={`${d.day}: ${Math.round(d.pct)}% full (${d.n} readings)`} />
                </div>
              </div>
              <div style={{ ...label, fontSize: 10, color: C.sub, marginTop: 12 }}>{d.short}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Forecast — predicted occupancy for the next 24h (predictor.py on the server)
// ─────────────────────────────────────────────────────────────────────────────
function ForecastChart({ forecast, live, rooms }) {
  const [sel, setSel] = useState('all')
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const caps = useMemo(() => Object.fromEntries(live.map(r => [r.room_name, r.capacity])), [live])
  const pts  = useMemo(() => forecastSeries(forecast, sel, caps), [forecast, sel, caps])

  const generatedAt = forecast.length ? new Date(forecast[0].generated_at) : null

  // best + peak windows over the next 12h, ignoring closed (≈0%) stretches
  const next12 = pts.filter(p => p.t - Date.now() < 12 * 3600e3)
  const open12 = next12.filter(p => p.pct > 1.5)
  const best = open12.length ? open12.reduce((m, p) => (p.pct < m.pct ? p : m), open12[0]) : null
  const peak = open12.length ? open12.reduce((m, p) => (p.pct > m.pct ? p : m), open12[0]) : null

  const timeShort = t => t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const timeFull  = t => `${DOW_SHORT[DOW[(t.getDay() + 6) % 7]]} ${timeShort(t)}`

  const W = 920, H = 240, padL = 40, padR = 16, padT = 16, padB = 30
  const cw = W - padL - padR, ch = H - padT - padB
  const maxY = Math.max(20, Math.ceil(Math.max(...pts.map(p => p.pct), 10) / 10) * 10)
  const n = Math.max(pts.length - 1, 1)
  const xAt = i => padL + (i / n) * cw
  const yAt = v => padT + ch - (v / maxY) * ch

  const linePts = pts.map((p, i) => `${xAt(i)},${yAt(p.pct)}`)
  const areaPath = pts.length
    ? `M ${xAt(0)},${yAt(0)} ` + pts.map((p, i) => `L ${xAt(i)},${yAt(p.pct)}`).join(' ') + ` L ${xAt(pts.length - 1)},${yAt(0)} Z`
    : ''

  const onMove = e => {
    const svg = svgRef.current; if (!svg || !pts.length) return
    const rect = svg.getBoundingClientRect()
    const xRel = (e.clientX - rect.left) / rect.width * W
    const i = Math.round((xRel - padL) / cw * n)
    if (i < 0 || i >= pts.length) { setHover(null); return }
    setHover({ i, p: pts[i] })
  }

  return (
    <div className="glass" style={{ padding: 'clamp(20px, 3vw, 30px)', marginBottom: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700 }}>Next 24 hours</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim, marginTop: 5 }}>
            predicted % full · {generatedAt ? `model run ${timeShort(generatedAt)}` : 'waiting for model'}
          </div>
        </div>
        <RoomSelect rooms={rooms} value={sel} onChange={setSel} />
      </div>

      {/* forecast stat tiles */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatTile k="Best time to go" v={best ? timeFull(best.t) : '—'} sub={best ? `${Math.round(best.pct)}% full expected` : 'no forecast yet'} accent={C.teal} />
        <StatTile k="Busiest ahead"   v={peak ? timeFull(peak.t) : '—'} sub={peak ? `${Math.round(peak.pct)}% full expected` : 'no forecast yet'} accent={C.red} />
      </div>

      {pts.length > 1 ? (
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', cursor: 'crosshair' }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={C.violet} stopOpacity="0.14" />
              <stop offset="100%" stopColor={C.violet} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* y gridlines */}
          {[0, 0.5, 1].map(t => (
            <g key={t}>
              <line x1={padL} y1={yAt(t * maxY)} x2={W - padR} y2={yAt(t * maxY)} stroke={C.line} strokeWidth="1" />
              <text x={padL - 8} y={yAt(t * maxY)} textAnchor="end" dominantBaseline="central" fill={C.dim} fontSize="10" fontFamily="var(--mono)">
                {Math.round(t * maxY)}%
              </text>
            </g>
          ))}

          <path d={areaPath} fill="url(#forecastFill)" />
          <polyline points={linePts.join(' ')} fill="none" stroke={C.violet} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
            strokeDasharray="5 5" />

          {/* x labels every 3h (12 × 15-min steps) */}
          {pts.filter((_, i) => i % 12 === 0).map(p => {
            const i = pts.indexOf(p)
            return <text key={p.t.getTime()} x={xAt(i)} y={H - 10} textAnchor="middle" fill={C.dim} fontSize="10" fontFamily="var(--mono)">{hourLabel(p.t.getHours())}</text>
          })}

          {/* hover marker */}
          {hover && (
            <g>
              <line x1={xAt(hover.i)} y1={padT} x2={xAt(hover.i)} y2={H - padB} stroke="#fff" strokeOpacity="0.18" strokeDasharray="4 4" />
              <circle cx={xAt(hover.i)} cy={yAt(hover.p.pct)} r="5" fill={C.violet} stroke="#06070d" strokeWidth="2" />
            </g>
          )}
        </svg>
      ) : (
        <div style={{ padding: '40px 0', textAlign: 'center', color: C.dim, fontFamily: 'var(--mono)', fontSize: 13 }}>
          No forecast available yet — the model runs every 30 minutes.
        </div>
      )}

      {/* hover readout */}
      {hover && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: C.sub, marginTop: 12 }}>
          <span style={{ color: C.text, fontWeight: 700 }}>{timeFull(hover.p.t)}</span> — expected{' '}
          <span style={{ color: band(hover.p.pct).c, fontWeight: 700 }}>{Math.round(hover.p.pct)}% full</span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Ultra-quiet windows — stretches in the next 24h where a room is open but
// predicted to hold barely-noticeable numbers of people (from /api/quiet)
// ─────────────────────────────────────────────────────────────────────────────
function QuietWindows({ quiet }) {
  const windows = (quiet.windows || []).filter(w => w.kind === 'next24')
  const thresholds = quiet.thresholds || {}

  const fmt = (iso, withDay) => {
    const d = new Date(iso)
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const today = d.toDateString() === new Date().toDateString()
    return withDay && !today ? `${d.toLocaleDateString([], { weekday: 'short' })} ${t}` : t
  }
  const byRoom = new Map()
  for (const w of windows) {
    if (!byRoom.has(w.room_name)) byRoom.set(w.room_name, [])
    byRoom.get(w.room_name).push(w)
  }

  return (
    <div className="glass" style={{ padding: 'clamp(18px, 3vw, 26px)', marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: byRoom.size ? 16 : 0 }}>
        <span style={{ fontFamily: 'var(--display)', fontSize: 15, fontWeight: 700, color: C.cyan }}>Ultra-quiet windows</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim }}>
          next 24h · open, but few enough people to barely notice
        </span>
      </div>

      {byRoom.size === 0 ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: C.dim }}>
          None expected in the next 24 hours.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[...byRoom.entries()].sort().map(([room, ws]) => (
            ws.map(w => (
              <span key={`${room}${w.start_time}`}
                title={`≤ ${thresholds[room] ?? '?'} people expected`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
                  border: '1px solid var(--line)', borderRadius: 9,
                  padding: '7px 12px', background: 'rgba(255,255,255,0.02)',
                }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.cyan, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{short(room)}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: C.sub }}>{fmt(w.start_time, true)}–{fmt(w.end_time)}</span>
              </span>
            ))
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Visit planner — pick any day + time, read the typical-week prediction
// ─────────────────────────────────────────────────────────────────────────────
const timeLabel12 = t => {
  const [h, m] = t.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function VisitPlanner({ baseline, live, rooms }) {
  const now = new Date()
  const [sel, setSel]   = useState('all')
  const [day, setDay]   = useState(DOW[(now.getDay() + 6) % 7])
  const [time, setTime] = useState(`${String(now.getMinutes() < 30 ? now.getHours() : (now.getHours() + 1) % 24).padStart(2, '0')}:${now.getMinutes() < 30 ? '30' : '00'}`)

  const caps  = useMemo(() => Object.fromEntries(live.map(r => [r.room_name, r.capacity])), [live])
  const curve = useMemo(() => baselineDay(baseline, sel, day, caps), [baseline, sel, day, caps])

  const pick = curve.find(p => p.time === time) || null
  const closed = pick && pick.pct < 1.5
  // selection-level ultra-quiet bar: sum of the matched rooms' thresholds
  const selThr = Object.entries(caps).filter(([name]) => matchRoom(name, sel))
    .reduce((s, [, cap]) => s + ultraThreshold(cap), 0)
  const ultra = pick && !closed && pick.people <= selThr
  const b = pick ? (ultra ? { label: 'ULTRA QUIET', c: C.cyan } : band(pick.pct)) : null

  // half-hour options, taken from the actual curve so they always match a slot
  const timeOptions = curve.filter(p => p.time.endsWith(':00') || p.time.endsWith(':30')).map(p => p.time)

  const W = 920, H = 130, padL = 40, padR = 16, padT = 12, padB = 26
  const cw = W - padL - padR, ch = H - padT - padB
  const maxY = Math.max(20, Math.ceil(Math.max(...curve.map(p => p.pct), 10) / 10) * 10)
  const n = Math.max(curve.length - 1, 1)
  const xAt = i => padL + (i / n) * cw
  const yAt = v => padT + ch - (v / maxY) * ch
  const pickIdx = pick ? curve.indexOf(pick) : -1

  return (
    <div className="glass" style={{ padding: 'clamp(20px, 3vw, 30px)', marginBottom: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700 }}>Typical week</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim, marginTop: 5 }}>
            pick a day and time — recent weeks weigh heaviest
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <RoomSelect rooms={rooms} value={sel} onChange={setSel} />
          <select value={day} onChange={e => setDay(e.target.value)}>
            {DOW.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={time} onChange={e => setTime(e.target.value)}>
            {timeOptions.map(t => <option key={t} value={t}>{timeLabel12(t)}</option>)}
          </select>
        </div>
      </div>

      {pick ? (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 20 }}>
          <div className="glass" style={{ padding: '16px 20px', flex: '1 1 200px' }}>
            <div style={{ ...label, fontSize: 9.5, color: C.sub, marginBottom: 8 }}>{DOW_SHORT[day]} {timeLabel12(time)} · expected</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 32, fontWeight: 600, lineHeight: 1, color: closed ? C.dim : C.text }}>
                {Math.round(pick.pct)}<span style={{ fontSize: 15, color: C.sub }}>%</span>
              </span>
              <span style={{ ...label, fontSize: 10.5, color: closed ? C.dim : b.c }}>{closed ? 'LIKELY CLOSED / EMPTY' : b.label}</span>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: C.sub, marginTop: 8 }}>
              ~{pick.people} people across selection
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '20px 0', color: C.dim, fontFamily: 'var(--mono)', fontSize: 13 }}>
          No baseline yet — the model runs every 30 minutes.
        </div>
      )}

      {/* day sparkline with picked-time marker */}
      {curve.length > 1 && (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
          {[0, 1].map(t => (
            <g key={t}>
              <line x1={padL} y1={yAt(t * maxY)} x2={W - padR} y2={yAt(t * maxY)} stroke={C.line} strokeWidth="1" />
              <text x={padL - 8} y={yAt(t * maxY)} textAnchor="end" dominantBaseline="central" fill={C.dim} fontSize="10" fontFamily="var(--mono)">
                {Math.round(t * maxY)}%
              </text>
            </g>
          ))}
          <polyline points={curve.map((p, i) => `${xAt(i)},${yAt(p.pct)}`).join(' ')} fill="none"
            stroke={C.violet} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
          {curve.filter((_, i) => i % 12 === 0).map(p => {
            const i = curve.indexOf(p)
            return <text key={p.time} x={xAt(i)} y={H - 8} textAnchor="middle" fill={C.dim} fontSize="10" fontFamily="var(--mono)">{hourLabel(Number(p.time.slice(0, 2)))}</text>
          })}
          {pickIdx >= 0 && (
            <g>
              <line x1={xAt(pickIdx)} y1={padT} x2={xAt(pickIdx)} y2={H - padB} stroke="#fff" strokeOpacity="0.22" strokeDasharray="4 4" />
              <circle cx={xAt(pickIdx)} cy={yAt(curve[pickIdx].pct)} r="5" fill={closed ? C.dim : band(curve[pickIdx].pct).c} stroke="#06070d" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Historical viewer — pick a room, explore its hour-of-day rhythm + stats
// ─────────────────────────────────────────────────────────────────────────────
function StatTile({ k, v, sub, accent = C.text }) {
  return (
    <div className="glass" style={{ padding: '16px 18px', flex: '1 1 130px' }}>
      <div style={{ ...label, fontSize: 9.5, color: C.sub, marginBottom: 8 }}>{k}</div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700, color: accent }}>{v}</div>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: C.dim, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function HistoricalViewer({ history, rooms }) {
  const [sel, setSel] = useState('all')
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const hours = useMemo(() => hourlyAverages(history, sel), [history, sel])
  const stat  = useMemo(() => summarize(history, sel), [history, sel])

  // only render the range that actually has readings (skip dead overnight hours)
  const active = hours.filter(h => h.n > 0)
  const firstH = active.length ? active[0].hour : 6
  const lastH  = active.length ? active[active.length - 1].hour : 23
  const shown  = hours.filter(h => h.hour >= firstH && h.hour <= lastH)

  const W = 920, H = 240, padL = 40, padR = 16, padT = 16, padB = 30
  const cw = W - padL - padR, ch = H - padT - padB
  const maxY = Math.max(20, Math.ceil(Math.max(...shown.map(h => h.pct), 10) / 10) * 10)
  const n = Math.max(shown.length - 1, 1)
  const xAt = i => padL + (i / n) * cw
  const yAt = v => padT + ch - (v / maxY) * ch

  const linePts = shown.map((h, i) => `${xAt(i)},${yAt(h.pct)}`)
  const areaPath = shown.length
    ? `M ${xAt(0)},${yAt(0)} ` + shown.map((h, i) => `L ${xAt(i)},${yAt(h.pct)}`).join(' ') + ` L ${xAt(shown.length - 1)},${yAt(0)} Z`
    : ''

  const onMove = e => {
    const svg = svgRef.current; if (!svg || !shown.length) return
    const rect = svg.getBoundingClientRect()
    const xRel = (e.clientX - rect.left) / rect.width * W
    const i = Math.round((xRel - padL) / cw * n)
    if (i < 0 || i >= shown.length) { setHover(null); return }
    setHover({ i, h: shown[i] })
  }

  const yTicks = [0, 0.5, 1]

  return (
    <div className="glass" style={{ padding: 'clamp(20px, 3vw, 30px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700 }}>Explore the history</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim, marginTop: 5 }}>
            average occupancy by time of day · {stat.samples.toLocaleString()} readings
          </div>
        </div>
        <RoomSelect rooms={rooms} value={sel} onChange={setSel} />
      </div>

      {/* stat tiles */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatTile k="Busiest day"   v={DOW_SHORT[stat.busiestDay.day] || '—'} sub={`${Math.round(stat.busiestDay.pct)}% avg full`} accent={C.amber} />
        <StatTile k="Peak hour"     v={hourLabel(stat.busiestHour.hour)}       sub={`${Math.round(stat.busiestHour.pct)}% avg full`} accent={C.red} />
        <StatTile k="Quietest hour" v={hourLabel(stat.quietHour.hour)}         sub={`${Math.round(stat.quietHour.pct)}% avg full`} accent={C.teal} />
        <StatTile k="Overall avg"   v={`${Math.round(stat.avg)}%`}             sub="full, all hours" />
      </div>

      {/* hourly area chart */}
      {shown.length > 1 ? (
        <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', cursor: 'crosshair' }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={C.teal} stopOpacity="0.16" />
              <stop offset="100%" stopColor={C.teal} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* y gridlines */}
          {yTicks.map(t => (
            <g key={t}>
              <line x1={padL} y1={yAt(t * maxY)} x2={W - padR} y2={yAt(t * maxY)} stroke={C.line} strokeWidth="1" />
              <text x={padL - 8} y={yAt(t * maxY)} textAnchor="end" dominantBaseline="central" fill={C.dim} fontSize="10" fontFamily="var(--mono)">
                {Math.round(t * maxY)}%
              </text>
            </g>
          ))}

          <path d={areaPath} fill="url(#areaFill)" />
          <polyline points={linePts.join(' ')} fill="none" stroke={C.teal} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {/* x labels every ~3h */}
          {shown.filter((_, i) => i % 3 === 0).map(h => {
            const i = shown.indexOf(h)
            return <text key={h.hour} x={xAt(i)} y={H - 10} textAnchor="middle" fill={C.dim} fontSize="10" fontFamily="var(--mono)">{hourLabel(h.hour)}</text>
          })}

          {/* hover marker */}
          {hover && (
            <g>
              <line x1={xAt(hover.i)} y1={padT} x2={xAt(hover.i)} y2={H - padB} stroke="#fff" strokeOpacity="0.18" strokeDasharray="4 4" />
              <circle cx={xAt(hover.i)} cy={yAt(hover.h.pct)} r="5" fill={C.teal} stroke="#06070d" strokeWidth="2" />
            </g>
          )}
        </svg>
      ) : (
        <div style={{ padding: '40px 0', textAlign: 'center', color: C.dim, fontFamily: 'var(--mono)', fontSize: 13 }}>
          Not enough history yet for this selection.
        </div>
      )}

      {/* hover readout */}
      {hover && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: C.sub, marginTop: 12 }}>
          <span style={{ color: C.text, fontWeight: 700 }}>{hourLabel(hover.h.hour)}</span> — avg{' '}
          <span style={{ color: band(hover.h.pct).c, fontWeight: 700 }}>{Math.round(hover.h.pct)}% full</span>{' '}
          <span style={{ color: C.dim }}>· {hover.h.n} readings</span>
        </div>
      )}
    </div>
  )
}

function Skeleton({ h = 160 }) {
  return <div className="skeleton" style={{ height: h, width: '100%' }} />
}

// ─────────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]         = useState('live')
  const [live, setLive]         = useState([])
  const [forecast, setForecast] = useState([])
  const [baseline, setBaseline] = useState([])
  const [quiet, setQuiet]       = useState({})
  const [history, setHistory]   = useState([])
  const [loadingHist, setLoadingHist] = useState(true)
  const [lastUpdate, setLastUpdate]   = useState(null)
  const [dlState, setDlState]   = useState('idle')

  const fetchLive = async () => {
    try {
      const res = await fetch(`${API}/api/live`)
      setLive(await res.json())
      setLastUpdate(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } catch (e) { console.error('live fetch failed:', e) }
  }

  const fetchForecast = async () => {
    try {
      const res = await fetch(`${API}/api/forecast`)
      setForecast(await res.json())
    } catch (e) { console.error('forecast fetch failed:', e) }
    try {
      const res = await fetch(`${API}/api/quiet`)
      setQuiet(await res.json())
    } catch (e) { console.error('quiet fetch failed:', e) }
  }

  useEffect(() => {
    fetchLive()
    fetchForecast()
    // baseline: one fetch — the typical-week curve only changes twice an hour
    ;(async () => {
      try {
        const res = await fetch(`${API}/api/baseline`)
        setBaseline(await res.json())
      } catch (e) { console.error('baseline fetch failed:', e) }
    })()
    const id = setInterval(() => { fetchLive(); fetchForecast() }, LIVE_REFRESH)
    // history: one bounded fetch for the aggregate views
    ;(async () => {
      try {
        const res = await fetch(`${API}/api/history?days=${HISTORY_DAYS}`)
        setHistory(await res.json())
      } catch (e) { console.error('history fetch failed:', e) }
      finally { setLoadingHist(false) }
    })()
    return () => clearInterval(id)
  }, [])

  const downloadFull = async () => {
    setDlState('loading')
    try {
      const res = await fetch(`${API}/api/history?days=${DOWNLOAD_DAYS}`)
      if (!res.ok) throw new Error(res.status)
      const data = await res.json()
      const blob = new Blob([toCSV(data)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `marino-tracker-${DOWNLOAD_DAYS}d-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      setDlState('done'); setTimeout(() => setDlState('idle'), 2500)
    } catch (e) { console.error('download failed:', e); setDlState('error'); setTimeout(() => setDlState('idle'), 3000) }
  }

  const rooms  = useMemo(() => [...new Set(history.map(r => r.room_name))].sort(), [history])
  const marino = live.filter(r => !isSquash(r.room_name))
  const squash = live.filter(r =>  isSquash(r.room_name))

  return (
    <div className="layout">
      <Sidebar live={live} lastUpdate={lastUpdate} view={view} setView={setView}
        onDownload={downloadFull} dlState={dlState} />

      <main className="main">
        {view === 'live' && (
          <section key="live" className="rise">
            <ViewHeader title="Live occupancy"
              sub={`per-room headcounts · auto-refresh 5 min${lastUpdate ? ` · updated ${lastUpdate}` : ''}`} />
            {live.length === 0
              ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 14 }}>
                  {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={180} />)}
                </div>
              : <>
                  <FacilityGroup title="Marino Recreation Center" rooms={marino} />
                  <FacilityGroup title="SquashBusters" rooms={squash} />
                </>}
          </section>
        )}

        {view === 'forecast' && (
          <section key="forecast" className="rise">
            <ViewHeader title="Forecast"
              sub="model regenerates every 30 min · weighted toward recent weeks" />
            <QuietWindows quiet={quiet} />
            <ForecastChart forecast={forecast} live={live} rooms={rooms} />
          </section>
        )}

        {view === 'planner' && (
          <section key="planner" className="rise">
            <ViewHeader title="Plan a visit"
              sub="typical-week prediction for any day and time" />
            <VisitPlanner baseline={baseline} live={live} rooms={rooms} />
          </section>
        )}

        {view === 'history' && (
          <section key="history" className="rise">
            <ViewHeader title="Patterns & history"
              sub={`aggregates over the last ${HISTORY_DAYS} days`} />
            {loadingHist
              ? <><div style={{ marginBottom: 22 }}><Skeleton h={280} /></div><Skeleton h={320} /></>
              : <>
                  <WeeklyChart history={history} rooms={rooms} />
                  <HistoricalViewer history={history} rooms={rooms} />
                </>}
          </section>
        )}
      </main>
    </div>
  )
}
