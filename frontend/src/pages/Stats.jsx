import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import Plot from 'react-plotly.js'
import api from '../api/client'
import { useAuth } from '../context/AuthContext'

const GOAL_OPTIONS = [
  'First Serve %', 'Return %', 'Unforced Errors', 'Serve Speed',
  'Net Points Won', 'First Serve % Won', 'Second Serve %', 'Double Faults',
]

const PLOTLY_LAYOUT = {
  template: 'plotly_dark',
  paper_bgcolor: '#21252b',
  plot_bgcolor: '#21252b',
  margin: { l: 40, r: 20, t: 40, b: 40 },
  font: { family: 'Inter, sans-serif', color: '#a1a7b4', weight: 600 },
  height: 350,
  autosize: true,
}

const PLOTLY_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToAdd: [{
    name: 'Fullscreen',
    icon: { width: 24, height: 24, path: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z' },
    click: function (gd) {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        gd.requestFullscreen()
      }
    },
  }],
  modeBarButtonsToRemove: [
    'zoom2d', 'pan2d', 'select2d', 'lasso2d', 'zoomIn2d', 'zoomOut2d',
    'autoScale2d', 'resetScale2d', 'hoverClosestCartesian', 'hoverCompareCartesian',
    'toggleSpikelines', 'sendDataToCloud',
  ],
}

export default function Stats() {
  const { user } = useAuth()
  const location = useLocation()
  const [data, setData] = useState(null)
  const [sharedData, setSharedData] = useState(null)
  const [teamData, setTeamData] = useState(null)
  const [sharerUsernames, setSharerUsernames] = useState([])
  const [selectedView, setSelectedView] = useState('My Stats')
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState({})
  const [shareUsername, setShareUsername] = useState('')
  const [shareMsg, setShareMsg] = useState('')
  const [selectedH2H, setSelectedH2H] = useState(0)

  const loadStats = useCallback(async () => {
    setLoading(true)
    try {
      if (selectedView === 'My Stats') {
        const res = await api.get('/stats')
        setData(res.data)
        setGoals(res.data.goals || {})
      } else if (selectedView === 'Team Stats') {
        const res = await api.get('/stats/shared', { params: { user: 'Team Stats' } })
        setTeamData(res.data.team_stats || [])
      } else {
        const res = await api.get('/stats/shared', { params: { user: selectedView } })
        setSharedData(res.data)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [selectedView])

  useEffect(() => {
    api.get('/stats/shared').then((res) => {
      const names = res.data.sharer_usernames || []
      setSharerUsernames(names)
    })
  }, [])

  useEffect(() => { loadStats() }, [loadStats])

  useEffect(() => {
    if (!loading && location.hash) {
      setTimeout(() => {
        const el = document.querySelector(location.hash)
        if (el) el.scrollIntoView({ behavior: 'smooth' })
      }, 100)
    }
  }, [loading, location.hash])

  const viewOptions = ['My Stats', ...sharerUsernames]
  if (sharerUsernames.length >= 2) viewOptions.push('Team Stats')

  const updateGoals = async (newGoals) => {
    setGoals(newGoals)
    await api.put('/stats/goals', { goals: newGoals })
    // Re-fetch stats to get updated goal_trends
    const res = await api.get('/stats')
    setData(res.data)
  }

  const handleShare = async (e) => {
    e.preventDefault()
    try {
      const res = await api.post('/stats/share', { username: shareUsername })
      setShareMsg(res.data.message)
      setShareUsername('')
    } catch (err) {
      setShareMsg(err.response?.data?.error || 'Failed to share')
    }
  }

  if (loading) return <div className="loading">Loading stats...</div>

  // Team Stats View
  if (selectedView === 'Team Stats' && teamData) {
    return (
      <div className="stats-page">
        <div className="stats-header">
          <h1>Team Stats Dashboard</h1>
          <select value={selectedView} onChange={(e) => setSelectedView(e.target.value)} className="view-selector">
            {viewOptions.map((v) => <option key={v}>{v}</option>)}
          </select>
        </div>
        {teamData.length === 0 ? (
          <p className="text-muted">No team stats available.</p>
        ) : (
          <>
            <div className="data-table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Player</th><th>Matches</th><th>Win Rate</th><th>1st Serve %</th>
                    <th>Serve Speed</th><th>Return %</th><th>Winners</th><th>UE</th>
                  </tr>
                </thead>
                <tbody>
                  {teamData.map((p) => (
                    <tr key={p.Player}>
                      <td>{p.Player}</td><td>{p.Matches}</td>
                      <td>{p['Win Rate (%)']}%</td><td>{p['Avg First Serve (%)']}</td>
                      <td>{p['Avg Serve Speed']}</td><td>{p['Avg Return (%)']}</td>
                      <td>{p['Avg Winners']}</td><td>{p['Avg Unforced Errors']}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="chart-grid">
              <Plot
                data={[{ type: 'bar', x: teamData.map((p) => p.Player), y: teamData.map((p) => p['Win Rate (%)']), marker: { color: '#22c55e' }, text: teamData.map((p) => `${p['Win Rate (%)']}%`), textposition: 'outside' }]}
                layout={{ ...PLOTLY_LAYOUT, title: 'Win Rate Comparison' }}
                config={PLOTLY_CONFIG}
                useResizeHandler
                style={{ width: '100%', height: '100%' }}
                className="chart"
              />
              <Plot
                data={[{ type: 'bar', x: teamData.map((p) => p.Player), y: teamData.map((p) => p['Avg Serve Speed']), marker: { color: '#3b82f6' }, text: teamData.map((p) => `${p['Avg Serve Speed']}`), textposition: 'outside' }]}
                layout={{ ...PLOTLY_LAYOUT, title: 'Serve Speed Comparison' }}
                config={PLOTLY_CONFIG}
                useResizeHandler
                style={{ width: '100%', height: '100%' }}
                className="chart"
              />
            </div>
            <Plot
              data={teamData.map((p) => {
                const normSpeed = p['Avg Serve Speed'] > 0 ? (p['Avg Serve Speed'] / 150) * 100 : 0
                const vals = [p['Win Rate (%)'], p['Avg First Serve (%)'], p['Avg Return (%)'], normSpeed]
                const cats = ['Win Rate', '1st Serve %', 'Return %', 'Serve Speed']
                return { type: 'scatterpolar', r: [...vals, vals[0]], theta: [...cats, cats[0]], name: p.Player, fill: 'toself', opacity: 0.6 }
              })}
              layout={{ ...PLOTLY_LAYOUT, title: 'Overall Comparison', polar: { radialaxis: { visible: true, range: [0, 100] } } }}
              config={PLOTLY_CONFIG}
              useResizeHandler
              style={{ width: '100%', height: '100%' }}
              className="chart chart-full"
            />
          </>
        )}
      </div>
    )
  }

  // Shared user view
  if (selectedView !== 'My Stats' && sharedData) {
    const sharedSummary = sharedData.summary || {}
    const sharedSurfaceWins = sharedData.surface_wins || {}
    const sharedRecord = sharedData.record || {}
    const sharedGoalTrends = sharedData.goal_trends || {}
    const sharedGoals = sharedData.goals || {}

    return (
      <div className="stats-page">
        <div className="stats-header">
          <h1>{selectedView}'s Stats Dashboard</h1>
          <select value={selectedView} onChange={(e) => setSelectedView(e.target.value)} className="view-selector">
            {viewOptions.map((v) => <option key={v}>{v}</option>)}
          </select>
        </div>

        {/* KPI Cards */}
        {sharedSummary.total_matches > 0 && (
          <div className="kpi-grid">
            <div className="metric-card">
              <h3>Total Matches</h3>
              <p className="metric-value">{sharedSummary.total_matches}</p>
            </div>
            <div className="metric-card">
              <h3>Win Rate</h3>
              <p className="metric-value">{sharedSummary.win_rate}%</p>
            </div>
            <div className="metric-card">
              <h3>Avg 1st Serve %</h3>
              <p className="metric-value">{sharedSummary.avg_first_serve}%</p>
            </div>
          </div>
        )}

        {/* Progress Goals (read-only) */}
        {Object.keys(sharedGoals).length > 0 && (
          <div className="goals-panel">
            <h3>Progress Goals</h3>
            <div className="chip-group">
              {Object.keys(sharedGoals).map((g) => (
                <span key={g} className="chip chip-active">{g}: {sharedGoals[g]}</span>
              ))}
            </div>
          </div>
        )}

        {/* Goal Progress Charts */}
        {Object.keys(sharedGoalTrends).length > 0 && (
          <>
            <h2>Goal Progress</h2>
            <div className="chart-grid">
              {Object.entries(sharedGoalTrends).map(([name, trend]) => (
                <Plot
                  key={name}
                  data={[
                    { type: 'scatter', mode: 'lines+markers', x: trend.dates, y: trend.values, name, connectgaps: true, line: { color: '#22c55e' } },
                    { type: 'scatter', mode: 'lines', x: [trend.dates[0], trend.dates[trend.dates.length - 1]], y: [trend.goal, trend.goal], name: 'Goal', line: { color: '#E4003A', dash: 'dash' } },
                  ]}
                  layout={{ ...PLOTLY_LAYOUT, title: `${name} Over Time`, yaxis: { title: name } }}
                  config={PLOTLY_CONFIG}
                  useResizeHandler
                  style={{ width: '100%', height: '100%' }}
                  className="chart"
                />
              ))}
            </div>
          </>
        )}

        {/* Detailed Analysis */}
        <hr />
        <div className="chart-grid">
          {Object.keys(sharedSurfaceWins).length > 0 && (
            <Plot
              data={[{
                type: 'pie',
                values: Object.values(sharedSurfaceWins),
                labels: Object.keys(sharedSurfaceWins),
                textinfo: 'percent+label',
                textposition: 'inside',
              }]}
              layout={{ ...PLOTLY_LAYOUT, title: 'Wins by Surface' }}
              config={PLOTLY_CONFIG}
              useResizeHandler
              style={{ width: '100%', height: '100%' }}
              className="chart"
            />
          )}
          {Object.keys(sharedRecord).length > 0 && (
            <Plot
              data={[
                { type: 'bar', x: Object.keys(sharedRecord), y: Object.values(sharedRecord).map((r) => r.wins), name: 'Wins', marker: { color: '#38B000' } },
                { type: 'bar', x: Object.keys(sharedRecord), y: Object.values(sharedRecord).map((r) => r.losses), name: 'Losses', marker: { color: '#E4003A' } },
              ]}
              layout={{ ...PLOTLY_LAYOUT, title: 'W/L Record vs Opponents', barmode: 'stack' }}
              config={PLOTLY_CONFIG}
              useResizeHandler
              style={{ width: '100%', height: '100%' }}
              className="chart"
            />
          )}
        </div>

        {/* Recent Matches Table */}
        {sharedData.stats?.length > 0 && (
          <>
            <hr />
            <h2>Recent Matches</h2>
            <div className="data-table-container">
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>Opponent</th><th>Result</th><th>Score</th><th>Surface</th></tr>
                </thead>
                <tbody>
                  {sharedData.stats.slice(-10).reverse().map((m, i) => (
                    <tr key={i}>
                      <td>{m['Match Date']}</td><td>{m['Opp. Name']}</td>
                      <td><span className={`badge ${m.Result === 'W' ? 'badge-win' : 'badge-loss'}`}>{m.Result}</span></td>
                      <td>{m['Match Score']}</td><td>{m['Surface Type']}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    )
  }

  // My Stats View
  if (!data) return <p className="text-muted">No data available.</p>

  const { summary, surface_wins, record, goal_trends, h2h_matches } = data

  return (
    <div className="stats-page">
      <div className="stats-header">
        <h1>Stats Dashboard</h1>
        <select value={selectedView} onChange={(e) => setSelectedView(e.target.value)} className="view-selector">
          {viewOptions.map((v) => <option key={v}>{v}</option>)}
        </select>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="metric-card">
          <h3>Total Matches</h3>
          <p className="metric-value">{summary.total_matches || 0}</p>
        </div>
        <div className="metric-card">
          <h3>Win Rate</h3>
          <p className="metric-value">{summary.win_rate || 0}%</p>
        </div>
        <div className="metric-card">
          <h3>Avg 1st Serve %</h3>
          <p className="metric-value">{summary.avg_first_serve || 0}%</p>
        </div>
      </div>

      {/* Progress Goals */}
      <div className="goals-panel">
        <h3>Progress Goals</h3>
        <div className="chip-group">
          {GOAL_OPTIONS.map((g) => (
            <button key={g} type="button"
              className={`chip ${goals[g] !== undefined ? 'chip-active' : ''}`}
              onClick={() => {
                const newGoals = { ...goals }
                if (newGoals[g] !== undefined) {
                  delete newGoals[g]
                } else {
                  newGoals[g] = { 'First Serve %': 70, 'Return %': 70, 'Unforced Errors': 15, 'Serve Speed': 70, 'Net Points Won': 15, 'First Serve % Won': 70, 'Second Serve %': 70, 'Double Faults': 1 }[g]
                }
                updateGoals(newGoals)
              }}
            >{g}</button>
          ))}
        </div>
        <div className="goals-slider-grid">
        {Object.entries(goals).map(([name, value]) => (
          <div key={name} className="goal-slider-item">
            <label>{name} Goal: {value}</label>
            <input type="range"
              min={name === 'Double Faults' ? 0 : name === 'Unforced Errors' || name === 'Net Points Won' ? 0 : 0}
              max={name === 'Double Faults' ? 5 : name === 'Unforced Errors' || name === 'Net Points Won' ? 50 : 100}
              value={value}
              onChange={(e) => updateGoals({ ...goals, [name]: parseInt(e.target.value) })}
            />
          </div>
        ))}
        </div>
      </div>

      {/* Goal Progress Charts */}
      {Object.keys(goal_trends || {}).length > 0 && (
        <>
          <h2>Goal Progress</h2>
          <div className="chart-grid">
            {Object.entries(goal_trends).map(([name, trend]) => (
              <Plot
                key={name}
                data={[
                  { type: 'scatter', mode: 'lines+markers', x: trend.dates, y: trend.values, name, connectgaps: true, line: { color: '#22c55e' } },
                  { type: 'scatter', mode: 'lines', x: [trend.dates[0], trend.dates[trend.dates.length - 1]], y: [trend.goal, trend.goal], name: 'Goal', line: { color: '#E4003A', dash: 'dash' } },
                ]}
                layout={{ ...PLOTLY_LAYOUT, title: `${name} Over Time`, yaxis: { title: name } }}
                config={PLOTLY_CONFIG}
                useResizeHandler
                style={{ width: '100%', height: '100%' }}
                className="chart"
              />
            ))}
          </div>
        </>
      )}

      {/* Detailed Analysis */}
      <hr />

      <div className="chart-grid">
        {/* Wins by Surface */}
        {Object.keys(surface_wins || {}).length > 0 && (
          <Plot
            data={[{
              type: 'pie',
              values: Object.values(surface_wins),
              labels: Object.keys(surface_wins),
              textinfo: 'percent+label',
              textposition: 'inside',
            }]}
            layout={{ ...PLOTLY_LAYOUT, title: 'Wins by Surface' }}
            config={PLOTLY_CONFIG}
            useResizeHandler
            style={{ width: '100%', height: '100%' }}
            className="chart"
          />
        )}

        {/* W/L Record */}
        {Object.keys(record || {}).length > 0 && (
          <Plot
            data={[
              { type: 'bar', x: Object.keys(record), y: Object.values(record).map((r) => r.wins), name: 'Wins', marker: { color: '#38B000' } },
              { type: 'bar', x: Object.keys(record), y: Object.values(record).map((r) => r.losses), name: 'Losses', marker: { color: '#E4003A' } },
            ]}
            layout={{ ...PLOTLY_LAYOUT, title: 'W/L Record vs Opponents', barmode: 'stack' }}
            config={PLOTLY_CONFIG}
            useResizeHandler
            style={{ width: '100%', height: '100%' }}
            className="chart"
          />
        )}
      </div>

      {/* Head-to-Head: Tracked Matches */}
      {h2h_matches && h2h_matches.length > 0 && (
        <>
          <hr />
          <h2 id="h2h">Head-to-Head: Tracked Matches</h2>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>Select a tracked match</p>
          <select
            className="view-selector"
            style={{ width: '100%', marginBottom: '1.5rem' }}
            value={selectedH2H}
            onChange={(e) => setSelectedH2H(Number(e.target.value))}
          >
            {h2h_matches.map((m, i) => (
              <option key={i} value={i}>
                {m['Match Date']} vs {m['Opp. Name']} ({m.Result === 'W' ? 'W' : 'L'})
              </option>
            ))}
          </select>
          {(() => {
            const m = h2h_matches[selectedH2H]
            if (!m) return null
            const playerName = user?.username || 'You'
            const oppName = m['Opp. Name'] || 'Opponent'

            const countStats = [
              { label: 'Aces', player: Number(m.Aces) || 0, opp: Number(m['Opp. Aces']) || 0 },
              { label: 'Double Faults', player: Number(m['Double Faults']) || 0, opp: Number(m['Opp. Double Faults']) || 0 },
              { label: 'Winners', player: Number(m.Winners) || 0, opp: Number(m['Opp. Winners']) || 0 },
              { label: 'Unforced Errors', player: Number(m['Unforced Errors']) || 0, opp: Number(m['Opp. Unforced Errors']) || 0 },
              { label: 'Forced Errors', player: Number(m['Forced Errors']) || 0, opp: Number(m['Opp. Forced Errors']) || 0 },
              { label: 'Net Points Won', player: Number(m['Net Points Won']) || 0, opp: Number(m['Opp. Net Points Won']) || 0 },
              { label: 'Points Won', player: Number(m['Points Won']) || 0, opp: Number(m['Opp. Points Won']) || 0 },
              { label: 'Break Points Won', player: Number(m['Break Points Won']) || 0, opp: Number(m['Opp. Break Points Won']) || 0 },
              { label: 'Break Points Saved', player: Number(m['Break Points Saved']) || 0, opp: Number(m['Opp. Break Points Saved']) || 0 },
            ]

            const pctStats = [
              { label: 'First Serve %', player: Number(m['First Serve %']) || 0, opp: Number(m['Opp. First Serve %']) || 0 },
              { label: 'First Serve % Won', player: Number(m['First Serve % Won']) || 0, opp: Number(m['Opp. First Serve % Won']) || 0 },
              { label: 'Second Serve %', player: Number(m['Second Serve %']) || 0, opp: Number(m['Opp. Second Serve %']) || 0 },
              { label: 'Return %', player: Number(m['Return %']) || 0, opp: Number(m['Opp. Return %']) || 0 },
            ]

            // Radar: combine all stats, normalize each stat independently to 0-100
            const allStats = [...countStats, ...pctStats]
            const radarLabels = allStats.map((s) => s.label)
            const playerRadar = allStats.map((s) => { const mx = Math.max(s.player, s.opp, 1); return (s.player / mx) * 100 })
            const oppRadar = allStats.map((s) => { const mx = Math.max(s.player, s.opp, 1); return (s.opp / mx) * 100 })

            // Parse score into games won
            const scoreStr = m['Match Score'] || ''
            const sets = scoreStr.split(',').map((s) => s.trim()).filter(Boolean)
            let playerGames = 0, oppGames = 0
            sets.forEach((s) => {
              const parts = s.split('-').map(Number)
              if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                playerGames += parts[0]
                oppGames += parts[1]
              }
            })

            const h2hRows = [
              { label: 'Aces', player: Number(m.Aces) || 0, opp: Number(m['Opp. Aces']) || 0 },
              { label: 'Double Faults', player: Number(m['Double Faults']) || 0, opp: Number(m['Opp. Double Faults']) || 0 },
              { label: 'First Serve %', player: `${Number(m['First Serve %']) || 0}%`, opp: `${Number(m['Opp. First Serve %']) || 0}%` },
              { label: 'First Serve % Won', player: `${Number(m['First Serve % Won']) || 0}%`, opp: `${Number(m['Opp. First Serve % Won']) || 0}%` },
              { label: 'Second Serve %', player: `${Number(m['Second Serve %']) || 0}%`, opp: `${Number(m['Opp. Second Serve %']) || 0}%` },
              { label: 'Return %', player: `${Number(m['Return %']) || 0}%`, opp: `${Number(m['Opp. Return %']) || 0}%` },
              { label: 'Winners', player: Number(m.Winners) || 0, opp: Number(m['Opp. Winners']) || 0 },
              { label: 'Unforced Errors', player: Number(m['Unforced Errors']) || 0, opp: Number(m['Opp. Unforced Errors']) || 0 },
              { label: 'Forced Errors', player: Number(m['Forced Errors']) || 0, opp: Number(m['Opp. Forced Errors']) || 0 },
              { label: 'Break Points Won', player: Number(m['Break Points Won']) || 0, opp: Number(m['Opp. Break Points Won']) || 0 },
              { label: 'Break Points Saved', player: Number(m['Break Points Saved']) || 0, opp: Number(m['Opp. Break Points Saved']) || 0 },
              { label: 'Net Points Won', player: Number(m['Net Points Won']) || 0, opp: Number(m['Opp. Net Points Won']) || 0 },
              { label: 'Points Won', player: Number(m['Points Won']) || 0, opp: Number(m['Opp. Points Won']) || 0 },
              { label: 'Games Won', player: playerGames, opp: oppGames },
            ]

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Row 1: H2H Table + Radar side by side */}
                <div className="h2h-charts-row">
                  <div className="h2h-table-card">
                    <div className="h2h-match-info">
                      <span>{m['Match Date']}</span>
                      <span>{m['Surface Type'] || ''}</span>
                      <span className={`h2h-result ${m.Result === 'W' ? 'win' : 'loss'}`}>{m.Result === 'W' ? 'WIN' : 'LOSS'}</span>
                    </div>
                    <div className="h2h-score-line">
                      <span>{scoreStr}</span>
                    </div>
                    <div className="h2h-players-header">
                      <div className="h2h-player-name">{playerName}</div>
                      <div className="h2h-vs">VS</div>
                      <div className="h2h-player-name">{oppName}</div>
                    </div>
                    <div className="h2h-stats-table">
                      {h2hRows.map((row) => (
                        <div key={row.label} className="h2h-stat-row">
                          <div className="h2h-stat-val left">{row.player}</div>
                          <div className="h2h-stat-label">{row.label}</div>
                          <div className="h2h-stat-val right">{row.opp}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Plot
                    data={[
                      { type: 'scatterpolar', r: [...playerRadar, playerRadar[0]], theta: [...radarLabels, radarLabels[0]], name: playerName, fill: 'toself', fillcolor: 'rgba(59,130,246,0.2)', line: { color: '#3b82f6' } },
                      { type: 'scatterpolar', r: [...oppRadar, oppRadar[0]], theta: [...radarLabels, radarLabels[0]], name: oppName, fill: 'toself', fillcolor: 'rgba(239,68,68,0.2)', line: { color: '#ef4444' } },
                    ]}
                    layout={{ ...PLOTLY_LAYOUT, title: 'Overall Comparison', polar: { radialaxis: { visible: true, range: [0, 100], gridcolor: 'rgba(255,255,255,0.25)', linecolor: 'rgba(255,255,255,0.25)' }, angularaxis: { gridcolor: 'rgba(255,255,255,0.2)', linecolor: 'rgba(255,255,255,0.25)', tickfont: { size: 10 } }, bgcolor: 'transparent' }, height: 600, margin: { l: 100, r: 100, t: 60, b: 100 } }}
                    config={PLOTLY_CONFIG}
                    useResizeHandler
                    style={{ width: '100%', height: '100%' }}
                    className="chart chart-h2h-radar"
                  />
                </div>

                {/* Row 2: Count Stats + Percentage Stats side by side */}
                <div className="h2h-charts-row">
                  <Plot
                    data={[
                      { type: 'bar', x: countStats.map((s) => s.label), y: countStats.map((s) => s.player), name: playerName, marker: { color: '#3b82f6' }, text: countStats.map((s) => String(s.player)), textposition: 'outside' },
                      { type: 'bar', x: countStats.map((s) => s.label), y: countStats.map((s) => s.opp), name: oppName, marker: { color: '#ef4444' }, text: countStats.map((s) => String(s.opp)), textposition: 'outside' },
                    ]}
                    layout={{ ...PLOTLY_LAYOUT, title: `${playerName} vs ${oppName}`, barmode: 'group', height: 500, xaxis: { tickangle: -45, tickfont: { size: 10, color: '#e0e0e0' }, automargin: true }, yaxis: { tickfont: { color: '#e0e0e0' } }, margin: { l: 50, r: 50, t: 60, b: 120 } }}
                    config={PLOTLY_CONFIG}
                    useResizeHandler
                    style={{ width: '100%', height: '100%' }}
                    className="chart"
                  />
                  <Plot
                    data={[
                      { type: 'bar', x: pctStats.map((s) => s.label), y: pctStats.map((s) => s.player), name: playerName, marker: { color: '#3b82f6' }, text: pctStats.map((s) => `${s.player}%`), textposition: 'outside' },
                      { type: 'bar', x: pctStats.map((s) => s.label), y: pctStats.map((s) => s.opp), name: oppName, marker: { color: '#ef4444' }, text: pctStats.map((s) => `${s.opp}%`), textposition: 'outside' },
                    ]}
                    layout={{ ...PLOTLY_LAYOUT, title: 'Serve & Return Comparison', barmode: 'group', yaxis: { title: '%', range: [0, 110], tickfont: { color: '#e0e0e0' } }, height: 500, xaxis: { tickangle: -45, tickfont: { size: 10, color: '#e0e0e0' }, automargin: true }, margin: { l: 50, r: 50, t: 60, b: 120 } }}
                    config={PLOTLY_CONFIG}
                    useResizeHandler
                    style={{ width: '100%', height: '100%' }}
                    className="chart"
                  />
                </div>
              </div>
            )
          })()}
        </>
      )}

      {/* Share Form */}
      <hr />
      <h2>Share Your Stats</h2>
      <form onSubmit={handleShare} className="share-form">
        <input type="text" value={shareUsername} onChange={(e) => setShareUsername(e.target.value)} placeholder="Enter username to share with" />
        <button type="submit" className="btn btn-primary">Share</button>
      </form>
      {shareMsg && <p className="text-muted">{shareMsg}</p>}
    </div>
  )
}
