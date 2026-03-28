import { useState, useEffect, useRef } from 'react'

const API = 'https://gym-api.cryark.net'

// ─── BRAND TOKENS ────────────────────────────────────────────────────────────
const BRAND = {
  bg:         '#030307',
  bg1:        '#0d0d14',
  bg2:        '#12121c',
  border:     '#1a1a2e',
  text:       '#FAFBFC',          // pure white — names, headers
  textBright: '#ffffff',          // brightest white — important data
  muted:      '#3A4F66',          // off-focus, secondary labels
  dim:        '#232338',          // very dim — subtle elements
  blue:       '#0085FF',
  teal:       '#00FFA3',
  navy:       '#192a3d',
}

// ─── BAND LOGIC ──────────────────────────────────────────────────────────────
function getBand(pct) {
  if (pct < 30) return { label: 'QUIET',    color: BRAND.teal }
  if (pct < 60) return { label: 'MODERATE', color: BRAND.blue }
  if (pct < 85) return { label: 'BUSY',     color: '#e8f54a' }
  return              { label: 'PACKED',   color: '#f54a4a' }
}

// ─── HEADER ──────────────────────────────────────────────────────────────────
// Frosted glass sticky header — links back to cryark.net
function Header() {
  return (
    <header style={{
      background:        'rgba(3, 3, 7, 0.55)',
      backdropFilter:    'blur(18px)',
      WebkitBackdropFilter: 'blur(18px)',
      borderBottom:      `1px solid rgba(255,255,255,0.06)`,
      padding:           '0 40px',
      height:            70,
      display:           'flex',
      alignItems:        'center',
      justifyContent:    'space-between',
      position:          'sticky',
      top:               0,
      zIndex:            100,
    }}>
      {/* Logo — links to main site */}
      <a href="https://cryark.net/home/" target="_blank" rel="noreferrer"
        style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
        <img
          src="https://cryark.net/wp-content/uploads/2026/01/CRYARK-scaled.png"
          alt="CRYARK"
          style={{ height: 36, objectFit: 'contain' }}
          onError={e => { e.target.style.display = 'none' }}
        />
      </a>

      {/* Page title in header nav */}
      <span style={{
        fontFamily:    'Comfortaa, sans-serif',
        fontSize:      13,
        color:         BRAND.teal,
        letterSpacing: 3,
        fontWeight:    700,
      }}>
        MARINO TRACKER
      </span>
    </header>
  )
}

// ─── FOOTER ──────────────────────────────────────────────────────────────────
// Site footer — update links here when cross-linking to other pages
function Footer() {
  return (
    <footer style={{
      background:   BRAND.bg1,
      borderTop:    `1px solid ${BRAND.border}`,
      padding:      '24px 40px',
      marginTop:    60,
      display:      'flex',
      alignItems:   'center',
      justifyContent: 'space-between',
      flexWrap:     'wrap',
      gap:          12,
    }}>
      {/* Copyright */}
      <span style={{
        fontFamily: 'Comfortaa, sans-serif',
        fontSize:   12,
        color:      BRAND.muted,
        fontWeight: 700,
      }}>
        © 2026 CRYARK — Marino Tracker
      </span>

      {/* Project credit */}
      <span style={{
        fontFamily: 'Comfortaa, sans-serif',
        fontSize:   11,
        color:      BRAND.teal,
        fontWeight: 700,
        letterSpacing: 1,
      }}>
        ✦ Verified Project by AG
      </span>

      {/* Data source note */}
      <span style={{
        fontFamily: 'monospace',
        fontSize:   11,
        color:      BRAND.dim,
      }}>
        Data sourced from Northeastern University Recreation
      </span>
    </footer>
  )
}

// ─── OCCUPANCY CARD ──────────────────────────────────────────────────────────
// Individual room card — shows live count, capacity bar, last measured time
function OccupancyCard({ room }) {
  const pct      = Math.round((room.count / room.capacity) * 100)
  const band     = getBand(pct)

  // format last_updated into readable local time
  const lastMeasured = room.last_updated
    ? new Date(room.last_updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—'

  // clean display name — strip facility prefix
  const displayName = room.room_name
    .replace('Marino Center ', '')
    .replace('SquashBusters ', '')

  return (
    <div style={{
      background:   BRAND.bg2,
      border:       `1px solid ${BRAND.border}`,
      borderTop:    `3px solid ${band.color}`,
      borderRadius: 10,
      padding:      '20px 24px',
      color:        BRAND.text,
      fontFamily:   'Comfortaa, sans-serif',
    }}>

      {/* Status badge */}
      <div style={{
        fontSize:      10,
        color:         band.color,
        letterSpacing: 3,
        fontWeight:    700,
        marginBottom:  10,
      }}>
        {band.label}
      </div>

      {/* Room name — pure white, bold */}
      <div style={{
        fontSize:     14,
        color:        BRAND.textBright,
        fontWeight:   700,
        marginBottom: 14,
        minHeight:    38,
        lineHeight:   1.3,
      }}>
        {displayName}
      </div>

      {/* Count — large, colored */}
      <div style={{
        fontSize:    48,
        color:       band.color,
        lineHeight:  1,
        fontFamily:  'monospace',
        fontWeight:  700,
      }}>
        {room.count}
      </div>

      {/* Capacity label — bright white, important data */}
      <div style={{
        fontSize:     12,
        color:        BRAND.textBright,
        fontWeight:   700,
        margin:       '6px 0 14px',
      }}>
        / {room.capacity} capacity
      </div>

      {/* Progress bar */}
      <div style={{
        background:   BRAND.bg1,
        borderRadius: 2,
        height:       4,
        overflow:     'hidden',
      }}>
        <div style={{
          width:        `${Math.min(pct, 100)}%`,
          height:       '100%',
          background:   band.color,
          borderRadius: 2,
          transition:   'width 1s ease',
        }} />
      </div>

      {/* Percentage + last measured */}
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginTop:      8,
      }}>
        <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 700 }}>
          {pct}% full
        </span>
        <span style={{ fontSize: 10, color: BRAND.muted }}>
          measured {lastMeasured}
        </span>
      </div>

    </div>
  )
}

// ─── FACILITY GROUP ───────────────────────────────────────────────────────────
// Groups cards under a labeled section with a divider line
function FacilityGroup({ title, rooms }) {
  if (!rooms.length) return null
  return (
    <div style={{ marginBottom: 40 }}>

      {/* Section label + divider */}
      <div style={{
        fontFamily:     'Comfortaa, sans-serif',
        fontSize:       11,
        color:          BRAND.teal,
        letterSpacing:  3,
        fontWeight:     700,
        marginBottom:   16,
        display:        'flex',
        alignItems:     'center',
        gap:            12,
      }}>
        {title}
        <div style={{ flex: 1, height: 1, background: BRAND.border }} />
      </div>

      {/* Card grid */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
        gap:                 16,
      }}>
        {rooms.map(room => (
          <OccupancyCard key={room.room_name} room={room} />
        ))}
      </div>

    </div>
  )
}

// ─── HISTORY CHART ────────────────────────────────────────────────────────────
// SVG line chart — hover anywhere to see values at that time
function HistoryChart({ history }) {
  const svgRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)

  if (!history || history.length === 0) {
    return (
      <div style={{
        background:   BRAND.bg2,
        border:       `1px solid ${BRAND.border}`,
        borderRadius: 10,
        padding:      40,
        color:        BRAND.muted,
        fontFamily:   'Comfortaa, sans-serif',
        fontSize:     13,
        textAlign:    'center',
        fontWeight:   700,
      }}>
        No historical data yet — check back after a few polls.
      </div>
    )
  }

  const rooms    = [...new Set(history.map(r => r.room_name))]
  const colors   = [BRAND.teal, BRAND.blue, '#e8f54a', '#f54a4a', '#a78bfa', '#60a5fa', '#f472b6', '#fb923c']
  const times    = [...new Set(history.map(r => r.polled_at))].sort()
  const maxCount = Math.max(...history.map(r => r.count), 1)

  const W = 900, H = 220, padL = 44, padB = 32, padR = 20, padT = 10
  const chartW = W - padL - padR
  const chartH = H - padB - padT

  const xScale = i => padL + (i / Math.max(times.length - 1, 1)) * chartW
  const yScale = v => padT + chartH - (v / maxCount) * chartH
  const yTicks = [0, 0.25, 0.5, 0.75, 1]

  const handleMouseMove = (e) => {
    const svg  = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const xRel = (e.clientX - rect.left) / rect.width * W
    const idx  = Math.round((xRel - padL) / chartW * (times.length - 1))
    if (idx < 0 || idx >= times.length) { setTooltip(null); return }
    const time = times[idx]
    const vals = rooms.map(room => {
      const r = history.find(h => h.room_name === room && h.polled_at === time)
      return { room, count: r ? r.count : null }
    }).filter(v => v.count !== null)
    setTooltip({ x: xScale(idx), time, vals })
  }

  return (
    <div style={{
      background:   BRAND.bg2,
      border:       `1px solid ${BRAND.border}`,
      borderRadius: 10,
      padding:      24,
      marginBottom: 40,
    }}>

      {/* Chart title */}
      <div style={{
        fontFamily:    'Comfortaa, sans-serif',
        fontSize:      11,
        color:         BRAND.teal,
        letterSpacing: 3,
        fontWeight:    700,
        marginBottom:  16,
      }}>
        HISTORICAL — LAST 7 DAYS
      </div>

      {/* SVG chart */}
      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Y grid lines + labels */}
        {yTicks.map(v => (
          <g key={v}>
            <line
              x1={padL} y1={yScale(v * maxCount)}
              x2={W - padR} y2={yScale(v * maxCount)}
              stroke={BRAND.border} strokeWidth={1}
            />
            <text
              x={padL - 6} y={yScale(v * maxCount)}
              textAnchor="end" dominantBaseline="central"
              fill={BRAND.muted} fontSize={10} fontFamily="monospace"
            >
              {Math.round(v * maxCount)}
            </text>
          </g>
        ))}

        {/* Room lines */}
        {rooms.map((room, ri) => {
          const roomData = history
            .filter(r => r.room_name === room)
            .sort((a, b) => a.polled_at.localeCompare(b.polled_at))
          const points = roomData.map(r => {
            const ti = times.indexOf(r.polled_at)
            return ti >= 0 ? `${xScale(ti)},${yScale(r.count)}` : null
          }).filter(Boolean).join(' ')
          return points ? (
            <polyline key={room}
              points={points}
              fill="none"
              stroke={colors[ri % colors.length]}
              strokeWidth={1.5}
              opacity={0.85}
            />
          ) : null
        })}

        {/* Hover vertical line */}
        {tooltip && (
          <line
            x1={tooltip.x} y1={padT}
            x2={tooltip.x} y2={H - padB}
            stroke="#ffffff" strokeWidth={1}
            opacity={0.15} strokeDasharray="4 4"
          />
        )}

        {/* X axis baseline */}
        <line
          x1={padL} y1={H - padB}
          x2={W - padR} y2={H - padB}
          stroke={BRAND.border} strokeWidth={1}
        />
      </svg>

      {/* Hover tooltip box */}
      {tooltip && (
        <div style={{
          background:   BRAND.bg1,
          border:       `1px solid ${BRAND.border}`,
          borderRadius: 6,
          padding:      '10px 14px',
          fontFamily:   'monospace',
          fontSize:      11,
          color:         BRAND.text,
          marginTop:     10,
          display:       'inline-block',
          minWidth:      220,
        }}>
          <div style={{ color: BRAND.muted, marginBottom: 6, fontWeight: 700 }}>
            {new Date(tooltip.time).toLocaleString()}
          </div>
          {tooltip.vals.map(v => (
            <div key={v.room} style={{
              display:        'flex',
              justifyContent: 'space-between',
              gap:            16,
              color:          colors[rooms.indexOf(v.room) % colors.length],
              marginBottom:   2,
            }}>
              <span>
                {v.room.replace('Marino Center ', '').replace('SquashBusters ', 'SB ')}
              </span>
              <span style={{ fontWeight: 700 }}>{v.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div style={{
        display:   'flex',
        flexWrap:  'wrap',
        gap:       '10px 20px',
        marginTop: 16,
      }}>
        {rooms.map((room, ri) => (
          <div key={room} style={{
            display:    'flex',
            alignItems: 'center',
            gap:        6,
            fontFamily: 'Comfortaa, sans-serif',
            fontSize:   11,
            color:      BRAND.muted,
            fontWeight: 700,
          }}>
            <div style={{
              width:        20,
              height:       2,
              background:   colors[ri % colors.length],
              borderRadius: 1,
            }} />
            {room.replace('Marino Center ', '').replace('SquashBusters ', 'SB ')}
          </div>
        ))}
      </div>

    </div>
  )
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
// Main layout — fetches live + historical data every 5 minutes
export default function App() {
  const [live, setLive]       = useState([])
  const [history, setHistory] = useState([])
  const [lastUpdate, setLastUpdate] = useState(null)

  const fetchData = async () => {
    try {
      const [liveRes, histRes] = await Promise.all([
        fetch(`${API}/api/live`),
        fetch(`${API}/api/history`),
      ])
      setLive(await liveRes.json())
      setHistory(await histRes.json())
      setLastUpdate(new Date().toLocaleTimeString())
    } catch (e) {
      console.error('Fetch failed:', e)
    }
  }

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 300000)
    return () => clearInterval(id)
  }, [])

  // ─── split live data by facility ─────────────────────────────────────────
  const marino = live.filter(r => !r.room_name.includes('SquashBusters'))
  const squash = live.filter(r =>  r.room_name.includes('SquashBusters'))

  return (
    <div style={{
      background:    BRAND.bg,
      minHeight:     '100vh',
      display:       'flex',
      flexDirection: 'column',
    }}>

      {/* ─── HEADER ──────────────────────────────────────────────────────── */}
      <Header />

      {/* ─── MAIN CONTENT ────────────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '40px 40px 0' }}>

        {/* Page title + last updated */}
        <div style={{ marginBottom: 40 }}>
          <div style={{
            fontFamily:    'Comfortaa, sans-serif',
            fontSize:      24,
            color:         BRAND.textBright,
            fontWeight:    700,
            letterSpacing: 1,
            marginBottom:  6,
          }}>
            Gym Congestion Tracker
          </div>
          <div style={{
            fontFamily: 'monospace',
            fontSize:   11,
            color:      BRAND.muted,
          }}>
            {lastUpdate ? `last updated ${lastUpdate}` : 'connecting...'}
            {' · '}refreshes every 5 minutes
          </div>
        </div>

        {/* ─── LIVE OCCUPANCY SECTION ──────────────────────────────────── */}
        <div style={{
          fontFamily:    'Comfortaa, sans-serif',
          fontSize:      11,
          color:         BRAND.muted,
          letterSpacing: 3,
          fontWeight:    700,
          marginBottom:  24,
        }}>
          LIVE OCCUPANCY
        </div>

        {live.length === 0
          ? <div style={{
              color:      BRAND.muted,
              fontFamily: 'monospace',
              marginBottom: 40,
            }}>
              Connecting to API...
            </div>
          : <>
              {/* ─── MARINO CARDS ──────────────────────────────────────── */}
              <FacilityGroup title="MARINO RECREATION CENTER" rooms={marino} />

              {/* ─── SQUASHBUSTERS CARDS ───────────────────────────────── */}
              <FacilityGroup title="SQUASHBUSTERS" rooms={squash} />
            </>
        }

        {/* ─── HISTORICAL CHART SECTION ────────────────────────────────── */}
        <div style={{
          fontFamily:    'Comfortaa, sans-serif',
          fontSize:      11,
          color:         BRAND.muted,
          letterSpacing: 3,
          fontWeight:    700,
          marginBottom:  16,
        }}>
          HISTORICAL DATA
        </div>
        <HistoryChart history={history} />

      </main>

      {/* ─── FOOTER ──────────────────────────────────────────────────────── */}
      <Footer />

    </div>
  )
}