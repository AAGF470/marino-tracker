import { useState, useEffect, useRef, useMemo } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Marino Tracker — live + historical NEU gym occupancy.
//
// Self-contained: React only, no component-library dependency. Visual language
// is "frosted glass / Framer" — glass panels (see .glass in index.css) over an
// aurora backdrop. Data comes from the same API as before:
//   GET /api/live                       → current occupancy per room
//   GET /api/history?days=N             → per-poll history rows
// The 90-day history is ~40MB, so the dashboard aggregates a small recent
// window for its charts and only pulls the full 90 days on the download click.
// ─────────────────────────────────────────────────────────────────────────────

const API           = 'https://gym-api.cryark.net'
const HISTORY_DAYS   = 14   // window fetched for the weekly/hourly aggregates
const DOWNLOAD_DAYS  = 90   // full export on the download button
const LIVE_REFRESH   = 300000 // 5 min

// ─── palette (JS mirror of index.css vars, for SVG/canvas colors) ────────────
const C = {
  teal: '#00ffa3', blue: '#0a84ff', violet: '#8b7bff', amber: '#ffc24a', red: '#ff5a6a',
  text: '#f4f6fb', sub: '#9aa3b8', dim: '#5b647d', line: 'rgba(255,255,255,0.09)',
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
const label = { fontFamily: 'var(--display)', fontSize: 11, letterSpacing: 2.5, fontWeight: 700, textTransform: 'uppercase' }

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
// Header — frosted sticky bar
// ─────────────────────────────────────────────────────────────────────────────
function Header() {
  return (
    <header className="glass" style={{
      position: 'sticky', top: 0, zIndex: 100,
      borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderTop: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 clamp(20px, 5vw, 44px)', height: 66,
    }}>
      <a href="https://cryark.net/home/" target="_blank" rel="noreferrer"
        style={{ display: 'flex', alignItems: 'center' }}>
        <img src="https://cryark.net/wp-content/uploads/2026/01/CRYARK-scaled.png" alt="CRYARK"
          style={{ height: 30, objectFit: 'contain' }} onError={e => { e.target.style.display = 'none' }} />
      </a>
      <span style={{ ...label, fontSize: 12, color: C.text, display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.teal, boxShadow: `0 0 12px ${C.teal}` }} />
        MARINO TRACKER
      </span>
    </header>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero — title + at-a-glance live busyness + download
// ─────────────────────────────────────────────────────────────────────────────
function Hero({ live, lastUpdate, onDownload, dlState }) {
  const active = live.filter(r => !r.is_closed && r.capacity > 0)
  const overall = active.length ? active.reduce((s, r) => s + pctOf(r), 0) / active.length : 0
  const totalPeople = live.reduce((s, r) => s + (r.count || 0), 0)
  const b = band(overall)

  return (
    <section className="rise" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 40 }}>
      <div style={{ minWidth: 260 }}>
        <div style={{ ...label, color: C.sub, marginBottom: 12 }}>Northeastern Recreation · Live</div>
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 'clamp(30px, 5vw, 46px)', fontWeight: 700, lineHeight: 1.04, letterSpacing: -0.5 }}>
          How busy is the<br />gym right now?
        </h1>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: C.dim, marginTop: 14 }}>
          {lastUpdate ? `updated ${lastUpdate}` : 'connecting…'} · auto-refresh 5 min
        </div>
      </div>

      {/* live busyness gauge + download */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div className="glass" style={{ padding: '18px 22px', minWidth: 190 }}>
          <div style={{ ...label, fontSize: 10, color: C.sub, marginBottom: 10 }}>Overall right now</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 40, fontWeight: 700, color: b.c, lineHeight: 1 }}>
              {Math.round(overall)}<span style={{ fontSize: 18 }}>%</span>
            </span>
            <span style={{ ...label, fontSize: 11, color: b.c }}>{b.label}</span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: C.sub, marginTop: 8 }}>
            {totalPeople} people in {active.length} open spaces
          </div>
        </div>
        <DownloadButton onDownload={onDownload} state={dlState} />
      </div>
    </section>
  )
}

function DownloadButton({ onDownload, state }) {
  const txt = { idle: 'Download 90-day data', loading: 'Preparing CSV…', done: 'Downloaded ✓', error: 'Failed — retry' }[state]
  const busy = state === 'loading'
  return (
    <button className="glass lift" onClick={busy ? undefined : onDownload} disabled={busy}
      style={{
        padding: '18px 22px', minWidth: 190, textAlign: 'left', color: C.text,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8,
        cursor: busy ? 'progress' : 'pointer',
        borderColor: state === 'done' ? C.teal : state === 'error' ? C.red : undefined,
      }}>
      <span style={{ ...label, fontSize: 10, color: C.sub }}>Full history</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, fontWeight: 700, fontFamily: 'var(--display)' }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={state === 'done' ? C.teal : C.teal} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: busy ? 'none' : 'translateY(1px)', animation: busy ? 'aurora 1s linear infinite' : 'none' }}>
          <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
        </svg>
        {txt}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim }}>{DOWNLOAD_DAYS} days · CSV export</span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Live occupancy card
// ─────────────────────────────────────────────────────────────────────────────
function OccupancyCard({ room, i }) {
  const pct  = room.capacity > 0 ? Math.round((room.count / room.capacity) * 100) : 0
  const b    = band(pct)
  const closed = room.is_closed
  const measured = room.last_updated
    ? new Date(room.last_updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div className="glass lift rise" style={{ padding: 22, position: 'relative', overflow: 'hidden', animationDelay: `${i * 40}ms`, opacity: closed ? 0.55 : 1 }}>
      {/* accent glow strip */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${b.c}, transparent 80%)` }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ ...label, fontSize: 10, color: b.c }}>{closed ? 'CLOSED' : b.label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: C.dim }}>{measured}</span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, minHeight: 40, lineHeight: 1.3, marginBottom: 12 }}>
        {clean(room.room_name)}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 44, fontWeight: 700, lineHeight: 1, color: closed ? C.dim : b.c }}>
          {room.count}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: C.sub }}>/ {room.capacity}</span>
      </div>

      {/* progress track */}
      <div style={{ marginTop: 16, height: 6, borderRadius: 20, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{
          width: `${Math.min(pct, 100)}%`, height: '100%', borderRadius: 20,
          background: `linear-gradient(90deg, ${b.c}, ${b.c}cc)`, boxShadow: `0 0 12px ${b.c}66`,
          transition: 'width 1s cubic-bezier(.2,.7,.2,1)',
        }} />
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.sub, marginTop: 8 }}>{pct}% full</div>
    </div>
  )
}

function FacilityGroup({ title, rooms }) {
  if (!rooms.length) return null
  return (
    <div style={{ marginBottom: 34 }}>
      <SectionLabel accent={C.sub}>{title}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
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
                    width: '100%', height: `${hPct}%`, minHeight: d.n ? 3 : 0, borderRadius: '8px 8px 4px 4px',
                    background: `linear-gradient(180deg, ${b.c}, ${b.c}55)`, boxShadow: `0 0 20px ${b.c}44`,
                    transition: 'height .8s cubic-bezier(.2,.7,.2,1)',
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
              <stop offset="0%"  stopColor={C.teal} stopOpacity="0.35" />
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
          <polyline points={linePts.join(' ')} fill="none" stroke={C.teal} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${C.teal}66)` }} />

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

// ─────────────────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{ marginTop: 56, padding: '28px clamp(20px, 5vw, 44px)', borderTop: '1px solid var(--line-soft)', display: 'flex', flexWrap: 'wrap', gap: '10px 24px', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim }}>© 2026 CRYARK · Marino Tracker</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>Designed &amp; built by</span>
        <a href="https://guillensolutions.com" target="_blank" rel="noreferrer"
          style={{ color: C.teal, fontWeight: 700, textDecoration: 'none', fontFamily: 'var(--display)', letterSpacing: 0.3 }}>
          Guillen Solutions ↗
        </a>
        <span style={{ color: C.dim, opacity: 0.6 }}>· project by AG</span>
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.dim }}>Data — Northeastern University Recreation</span>
    </footer>
  )
}

function Skeleton({ h = 160 }) {
  return <div className="skeleton" style={{ height: h, width: '100%' }} />
}

// ─────────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [live, setLive]         = useState([])
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

  useEffect(() => {
    fetchLive()
    const id = setInterval(fetchLive, LIVE_REFRESH)
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
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header />

      <main style={{ flex: 1, width: '100%', maxWidth: 1180, margin: '0 auto', padding: 'clamp(28px, 5vw, 48px) clamp(20px, 5vw, 44px) 0' }}>
        <Hero live={live} lastUpdate={lastUpdate} onDownload={downloadFull} dlState={dlState} />

        {/* live occupancy */}
        <SectionLabel>Live occupancy</SectionLabel>
        {live.length === 0
          ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16, marginBottom: 34 }}>
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={190} />)}
            </div>
          : <>
              <FacilityGroup title="Marino Recreation Center" rooms={marino} />
              <FacilityGroup title="SquashBusters" rooms={squash} />
            </>}

        {/* historical section */}
        <SectionLabel accent={C.blue}>Patterns &amp; history</SectionLabel>
        {loadingHist
          ? <><div style={{ marginBottom: 22 }}><Skeleton h={280} /></div><Skeleton h={320} /></>
          : <>
              <WeeklyChart history={history} rooms={rooms} />
              <HistoricalViewer history={history} rooms={rooms} />
            </>}
      </main>

      <Footer />
    </div>
  )
}
