import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'

const INITIAL_STATS = () => ({
  aces: 0, double_faults: 0, winners: 0,
  forehand_winners: 0, backhand_winners: 0, net_winners: 0,
  forced_errors: 0, forehand_forced: 0, backhand_forced: 0, net_forced: 0,
  unforced_errors: 0, forehand_unforced: 0, backhand_unforced: 0, net_unforced: 0,
  first_serves_in: 0, first_serves_total: 0,
  second_serves_in: 0, second_serves_total: 0,
  points_won: 0, first_serve_points_won: 0,
  return_points_won: 0, return_points_total: 0,
  return_attempts: 0, returns_in: 0,
  break_points_converted: 0, break_points_opportunities: 0,
  break_points_saved: 0, break_points_faced: 0,
})

const FORMAT_OPTIONS = ['No Ads', '3rd Full Set', 'Short Sets to 4']

function getPointDisplay(points, oppPoints, hasAds) {
  if (points < 3 && oppPoints < 3) return ['0', '15', '30', '40'][points]
  if (points >= 3 && oppPoints >= 3) {
    if (!hasAds) return '40'
    if (points === oppPoints) return '40'
    return points > oppPoints ? 'AD' : '40'
  }
  return points >= 3 ? '40' : ['0', '15', '30'][points]
}

export default function Track() {
  const { user } = useAuth()
  const [phase, setPhase] = useState('setup')
  const [p1Name, setP1Name] = useState(user?.first_name || user?.username || '')
  const [p2Name, setP2Name] = useState('')
  const [matchFormat, setMatchFormat] = useState([])
  const [surfaceType, setSurfaceType] = useState('Hard')
  const [server, setServer] = useState(null)
  const [p1Points, setP1Points] = useState(0)
  const [p2Points, setP2Points] = useState(0)
  const [p1Games, setP1Games] = useState([0])
  const [p2Games, setP2Games] = useState([0])
  const [p1Sets, setP1Sets] = useState(0)
  const [p2Sets, setP2Sets] = useState(0)
  const [currentSet, setCurrentSet] = useState(0)
  const [firstServe, setFirstServe] = useState(true)
  const [currentPointServeType, setCurrentPointServeType] = useState(null)
  const [pendingPointWinner, setPendingPointWinner] = useState(null)
  const [stats, setStats] = useState({ player1: INITIAL_STATS(), player2: INITIAL_STATS() })
  const [history, setHistory] = useState([])
  const [startTime] = useState(null)
  const [matchDescription, setMatchDescription] = useState('')
  const [mentalGame, setMentalGame] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [saveError, setSaveError] = useState('')
  const [previousOpponents, setPreviousOpponents] = useState([])
  const [showP2Suggestions, setShowP2Suggestions] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [trackingFor, setTrackingFor] = useState(null) // {code, playerName} or null
  const [codeInput, setCodeInput] = useState('')
  const [codeError, setCodeError] = useState('')
  const [generatedCode, setGeneratedCode] = useState(null) // {code, expiresAt}
  const [activePanel, setActivePanel] = useState(null) // 'enter' | 'generate' | null

  useEffect(() => {
    setP1Name(trackingFor ? trackingFor.playerName : (user?.first_name || user?.username || ''))
  }, [trackingFor, user])

  useEffect(() => {
    api.get('/matches').then((res) => {
      const m = res.data.matches || []
      const names = [...new Set(m.map((r) => r['Opp. Name']).filter(Boolean))].sort()
      setPreviousOpponents(names)
    }).catch(() => {})
  }, [])

  const hasAds = !matchFormat.includes('No Ads')

  const saveHistory = useCallback(() => {
    setHistory((h) => [...h, JSON.parse(JSON.stringify({
      p1Points, p2Points, p1Games: [...p1Games], p2Games: [...p2Games],
      p1Sets, p2Sets, currentSet, server, firstServe, currentPointServeType,
      phase, stats,
    }))])
  }, [p1Points, p2Points, p1Games, p2Games, p1Sets, p2Sets, currentSet, server, firstServe, currentPointServeType, phase, stats])

  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setP1Points(prev.p1Points); setP2Points(prev.p2Points)
    setP1Games(prev.p1Games); setP2Games(prev.p2Games)
    setP1Sets(prev.p1Sets); setP2Sets(prev.p2Sets)
    setCurrentSet(prev.currentSet); setServer(prev.server)
    setFirstServe(prev.firstServe); setCurrentPointServeType(prev.currentPointServeType)
    setPhase(prev.phase); setStats(prev.stats)
    setPendingPointWinner(null)
  }

  const switchServer = () => setServer((s) => s === 1 ? 2 : 1)

  const awardPoint = useCallback((player) => {
    const serverKey = server === 1 ? 'player1' : 'player2'
    const returnerKey = server === 1 ? 'player2' : 'player1'
    const returner = server === 1 ? 2 : 1

    const sp = server === 1 ? p1Points : p2Points
    const rp = server === 1 ? p2Points : p1Points

    // Break point detection
    let isBreakPoint = false
    if (rp >= 3) {
      if (sp < 3) isBreakPoint = true
      else if (sp >= 3) {
        if (!hasAds) isBreakPoint = true
        else if (rp > sp) isBreakPoint = true
      }
    }

    setStats((prev) => {
      const next = JSON.parse(JSON.stringify(prev))
      if (isBreakPoint) {
        next[returnerKey].break_points_opportunities++
        next[serverKey].break_points_faced++
      }

      if (player === 1) next.player1.points_won++
      else next.player2.points_won++

      if (isBreakPoint) {
        if (player === returner) next[returnerKey].break_points_converted++
        else next[serverKey].break_points_saved++
      }

      next[returnerKey].return_points_total++
      if (player === server) {
        if (currentPointServeType === 'first') next[serverKey].first_serve_points_won++
      } else {
        next[returnerKey].return_points_won++
      }

      return next
    })

    // Check game win
    let newP1 = player === 1 ? p1Points + 1 : p1Points
    let newP2 = player === 2 ? p2Points + 1 : p2Points

    let gameWon = false, winner = null
    if (hasAds) {
      if (newP1 >= 4 && newP1 - newP2 >= 2) { gameWon = true; winner = 1 }
      else if (newP2 >= 4 && newP2 - newP1 >= 2) { gameWon = true; winner = 2 }
    } else {
      if (newP1 >= 4 && newP1 > newP2) { gameWon = true; winner = 1 }
      else if (newP2 >= 4 && newP2 > newP1) { gameWon = true; winner = 2 }
    }

    if (gameWon) {
      const newP1G = [...p1Games]
      const newP2G = [...p2Games]
      if (winner === 1) newP1G[currentSet]++
      else newP2G[currentSet]++

      const g1 = newP1G[currentSet]
      const g2 = newP2G[currentSet]
      const gamesToWin = matchFormat.includes('Short Sets to 4') ? 4 : 6
      const isThirdSet = currentSet === 2
      const allowTb = !(isThirdSet && matchFormat.includes('3rd Full Set'))

      let setWon = false, setWinner = null
      if (g1 >= gamesToWin && g1 - g2 >= 2) { setWon = true; setWinner = 1 }
      else if (g2 >= gamesToWin && g2 - g1 >= 2) { setWon = true; setWinner = 2 }
      else if (allowTb) {
        if (g1 === gamesToWin + 1 && g2 === gamesToWin) { setWon = true; setWinner = 1 }
        else if (g2 === gamesToWin + 1 && g1 === gamesToWin) { setWon = true; setWinner = 2 }
      }

      if (setWon) {
        const newP1S = setWinner === 1 ? p1Sets + 1 : p1Sets
        const newP2S = setWinner === 2 ? p2Sets + 1 : p2Sets
        setP1Sets(newP1S); setP2Sets(newP2S)

        if (newP1S >= 2 || newP2S >= 2) {
          setP1Games(newP1G); setP2Games(newP2G)
          setP1Points(0); setP2Points(0)
          setPhase('match_complete')
          switchServer()
          return
        }
        newP1G.push(0); newP2G.push(0)
        setCurrentSet((s) => s + 1)
      }

      setP1Games(newP1G); setP2Games(newP2G)
      setP1Points(0); setP2Points(0)
      switchServer()
    } else {
      setP1Points(newP1); setP2Points(newP2)
    }

    setFirstServe(true)
    if (!gameWon || phase !== 'match_complete') setPhase('service')
  }, [server, p1Points, p2Points, p1Games, p2Games, p1Sets, p2Sets, currentSet, currentPointServeType, hasAds, matchFormat, phase])

  const recordServe = (result) => {
    saveHistory()
    const sKey = server === 1 ? 'player1' : 'player2'

    setStats((prev) => {
      const next = JSON.parse(JSON.stringify(prev))
      if (firstServe) next[sKey].first_serves_total++
      else next[sKey].second_serves_total++

      if (result === 'ace') {
        next[sKey].aces++
        if (firstServe) next[sKey].first_serves_in++
        else next[sKey].second_serves_in++
      } else if (result === 'fault') {
        // handled below
      } else if (result === 'in_court' || result === 'return_error') {
        if (firstServe) next[sKey].first_serves_in++
        else next[sKey].second_serves_in++
      }
      return next
    })

    if (result === 'ace') {
      setCurrentPointServeType(firstServe ? 'first' : 'second')
      awardPoint(server)
    } else if (result === 'fault') {
      if (firstServe) {
        setFirstServe(false)
      } else {
        setStats((prev) => {
          const next = JSON.parse(JSON.stringify(prev))
          next[sKey].double_faults++
          return next
        })
        setCurrentPointServeType('second')
        const opp = server === 1 ? 2 : 1
        awardPoint(opp)
        setFirstServe(true)
      }
    } else if (result === 'return_error') {
      const returnerKey = server === 1 ? 'player2' : 'player1'
      setStats((prev) => {
        const next = JSON.parse(JSON.stringify(prev))
        next[returnerKey].unforced_errors++
        next[returnerKey].return_attempts++
        return next
      })
      setCurrentPointServeType(firstServe ? 'first' : 'second')
      awardPoint(server)
    } else if (result === 'in_court') {
      const returnerKey = server === 1 ? 'player2' : 'player1'
      setStats((prev) => {
        const next = JSON.parse(JSON.stringify(prev))
        next[returnerKey].return_attempts++
        next[returnerKey].returns_in++
        return next
      })
      setCurrentPointServeType(firstServe ? 'first' : 'second')
      setPendingPointWinner(null)
      setPhase('select_point_winner')
    }
  }

  const recordPointResult = (player, resultType, shotType) => {
    saveHistory()
    const pKey = player === 1 ? 'player1' : 'player2'

    setStats((prev) => {
      const next = JSON.parse(JSON.stringify(prev))
      if (resultType === 'winner') {
        next[pKey].winners++
        if (shotType === 'forehand') next[pKey].forehand_winners++
        else if (shotType === 'backhand') next[pKey].backhand_winners++
        else if (shotType === 'net') next[pKey].net_winners++
      } else if (resultType === 'forced_error') {
        next[pKey].forced_errors++
        if (shotType === 'forehand') next[pKey].forehand_forced++
        else if (shotType === 'backhand') next[pKey].backhand_forced++
        else if (shotType === 'net') next[pKey].net_forced++
      } else if (resultType === 'unforced_error') {
        next[pKey].unforced_errors++
        if (shotType === 'forehand') next[pKey].forehand_unforced++
        else if (shotType === 'backhand') next[pKey].backhand_unforced++
        else if (shotType === 'net') next[pKey].net_unforced++
      }
      return next
    })

    if (resultType === 'winner') {
      awardPoint(player)
    } else {
      const opp = player === 1 ? 2 : 1
      awardPoint(opp)
    }
    setFirstServe(true)
  }

  const handleSave = async () => {
    if (!matchDescription.trim()) {
      setSaveError('Match Description is required.')
      return
    }
    if (!mentalGame.trim()) {
      setSaveError('Mental Game is required.')
      return
    }
    setSaveError('')
    const scoreParts = p1Games.map((g, i) => `${g}-${p2Games[i]}`)
    const matchScore = scoreParts.join(', ')
    const result = p1Sets > p2Sets ? 'W' : 'L'
    const matchDate = startTime ? startTime.toISOString().split('T')[0] : new Date().toISOString().split('T')[0]

    try {
      await api.post('/track/save', {
        player1_stats: stats.player1,
        player2_stats: stats.player2,
        match_info: {
          match_date: matchDate,
          match_score: matchScore,
          surface_type: surfaceType,
          opponent_name: p2Name,
          result,
          match_description: matchDescription,
          mental_game: mentalGame,
        },
        session_code: trackingFor?.code || '',
      })
      setSaveMsg(trackingFor ? `Match saved to ${trackingFor.playerName}'s Match Log!` : 'Match saved to your Match Log!')
    } catch (err) {
      setSaveMsg(err.response?.data?.error || 'Failed to save match')
    }
  }

  const handleGenerateCode = async () => {
    try {
      const res = await api.post('/track/generate-code')
      setGeneratedCode(res.data)
    } catch (err) {
      console.error('Failed to generate code', err)
    }
  }

  const handleEnterCode = async () => {
    if (!codeInput.trim()) return
    setCodeError('')
    try {
      const res = await api.get(`/track/verify-code?code=${codeInput.trim().toUpperCase()}`)
      setTrackingFor({ code: codeInput.trim().toUpperCase(), playerName: res.data.player_name })
      setCodeInput('')
    } catch (err) {
      setCodeError(err.response?.data?.error || 'Invalid or expired code')
    }
  }

  const resetMatch = () => {
    setPhase('setup'); setP2Name('')
    setMatchFormat([]); setSurfaceType('Hard'); setServer(null)
    setP1Points(0); setP2Points(0); setP1Games([0]); setP2Games([0])
    setP1Sets(0); setP2Sets(0); setCurrentSet(0)
    setFirstServe(true); setCurrentPointServeType(null)
    setStats({ player1: INITIAL_STATS(), player2: INITIAL_STATS() })
    setHistory([]); setMatchDescription(''); setMentalGame(''); setSaveMsg(''); setSaveError('')
    setPendingPointWinner(null)
  }

  // Score display component
  const ScoreCard = () => (
    <div className="track-score-card">
      <div className="track-player-row">
        <span className={`track-player-name ${server === 1 ? 'serving' : ''}`}>{p1Name}</span>
        <div className="track-set-scores">
          {p1Games.map((g, i) => <span key={i} className={`set-score ${i === currentSet ? 'current' : ''}`}>{g}</span>)}
        </div>
      </div>
      <div className="track-player-row">
        <span className={`track-player-name ${server === 2 ? 'serving' : ''}`}>{p2Name}</span>
        <div className="track-set-scores">
          {p2Games.map((g, i) => <span key={i} className={`set-score ${i === currentSet ? 'current' : ''}`}>{g}</span>)}
        </div>
      </div>
    </div>
  )

  const PointDisplay = () => (
    <div className="track-point-display">
      <div className="track-point-player">
        <div className="track-point-name">{p1Name.slice(0, 10)}</div>
        <div className="track-point-score">{getPointDisplay(p1Points, p2Points, hasAds)}</div>
      </div>
      <div className="track-point-sep">:</div>
      <div className="track-point-player">
        <div className="track-point-name">{p2Name.slice(0, 10)}</div>
        <div className="track-point-score">{getPointDisplay(p2Points, p1Points, hasAds)}</div>
      </div>
    </div>
  )

  // SETUP
  if (phase === 'setup') {
    return (
      <div className="track-page">
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <h1 style={{ margin: 0 }}>Live Tracker</h1>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
            <div style={{ display: 'flex', gap: '0.6rem' }}>
              <button
                className={`btn btn-sm ${activePanel === 'enter' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setActivePanel((p) => p === 'enter' ? null : 'enter')}
              >Enter Code</button>
              <button
                className={`btn btn-sm ${activePanel === 'generate' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => { setActivePanel((p) => p === 'generate' ? null : 'generate'); if (activePanel !== 'generate') handleGenerateCode() }}
              >Generate Code</button>
            </div>
            <span style={{ fontSize: '0.65rem', color: 'var(--muted-text)', textAlign: 'center', width: '100%' }}>Enter code to track other player match. Generate code to have someone track for you.</span>
          </div>
        </div>

        {/* Enter code panel */}
        {activePanel === 'enter' && !trackingFor && (
          <div style={{ background: 'var(--card-bg, #1a1a2e)', border: '1px solid var(--border-color, #2a2a3e)', borderRadius: '10px', padding: '1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'flex-end', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '160px' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--muted-text)', display: 'block', marginBottom: '0.4rem' }}>Enter tracking code from the player</label>
              <input
                type="text"
                placeholder="e.g. K8ZCME"
                value={codeInput}
                onChange={(e) => { setCodeInput(e.target.value.toUpperCase()); setCodeError('') }}
                style={{ width: '100%', textTransform: 'uppercase', letterSpacing: '0.15em', boxSizing: 'border-box' }}
                maxLength={6}
                autoFocus
              />
              {codeError && <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0.35rem 0 0' }}>{codeError}</p>}
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleEnterCode}>Track for Player</button>
          </div>
        )}

        {/* Generate code panel */}
        {activePanel === 'generate' && (
          <div style={{ background: 'var(--card-bg, #1a1a2e)', border: '1px solid var(--border-color, #2a2a3e)', borderRadius: '10px', padding: '1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted-text)', marginBottom: '0.25rem' }}>Share this code with a parent or friend so they can track your match live.</div>
            </div>
            {generatedCode ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <span style={{ fontFamily: 'monospace', fontSize: '1.75rem', fontWeight: 700, letterSpacing: '0.25em', color: '#f5c518' }}>{generatedCode.code}</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--muted-text)' }}>valid 24h</span>
              </div>
            ) : (
              <button className="btn btn-outline btn-sm" onClick={handleGenerateCode}>Generate Code</button>
            )}
          </div>
        )}

        {/* Tracking for banner */}
        {trackingFor && (
          <div style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: '#22c55e', fontWeight: 600 }}>Tracking for: {trackingFor.playerName}</span>
            <button className="btn btn-outline btn-sm" onClick={() => setTrackingFor(null)}>Cancel</button>
          </div>
        )}

        <h2>Match Setup</h2>
        <div className="form-row">
          <div className="form-group"><label>You</label><input value={p1Name} readOnly style={{ opacity: 0.7, cursor: 'default' }} /></div>
          <div className="form-group">
            <label>Player 2 <span style={{ color: '#ef4444' }}>*</span></label>
            <div className="autocomplete-wrapper">
              <input value={p2Name}
                onChange={(e) => { setP2Name(e.target.value); setShowP2Suggestions(true) }}
                onFocus={() => setShowP2Suggestions(true)}
                onBlur={() => setTimeout(() => setShowP2Suggestions(false), 150)}
                placeholder="Enter opponent name *"
                autoComplete="off" />
              {showP2Suggestions && p2Name && previousOpponents.filter((name) =>
                name.toLowerCase().includes(p2Name.toLowerCase()) && name.toLowerCase() !== p2Name.toLowerCase()
              ).length > 0 && (
                <ul className="autocomplete-list">
                  {previousOpponents.filter((name) =>
                    name.toLowerCase().includes(p2Name.toLowerCase()) && name.toLowerCase() !== p2Name.toLowerCase()
                  ).map((name) => (
                    <li key={name} onMouseDown={() => { setP2Name(name); setShowP2Suggestions(false) }}>
                      {name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Match Format</label>
            <div className="chip-group">
              {FORMAT_OPTIONS.map((o) => (
                <button key={o} type="button"
                  className={`chip ${matchFormat.includes(o) ? 'chip-active' : ''}`}
                  onClick={() => setMatchFormat((f) => f.includes(o) ? f.filter((x) => x !== o) : [...f, o])}
                >{o}</button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>Surface</label>
            <select value={surfaceType} onChange={(e) => setSurfaceType(e.target.value)}>
              <option>Hard</option><option>Clay</option><option>Grass</option>
            </select>
          </div>
        </div>
        {setupError && <div className="alert alert-error">{setupError}</div>}
        <button className="btn btn-primary btn-full" onClick={() => {
          if (!p2Name.trim()) { setSetupError('Player 2 name is required.'); return }
          setSetupError('')
          if (p1Name && p2Name) setPhase('select_server')
        }}>Start Match</button>
      </div>
    )
  }

  // SELECT SERVER
  if (phase === 'select_server') {
    return (
      <div className="track-page">
        <h1>Live Tracker</h1>
        <ScoreCard />
        <PointDisplay />
        <h3>Who is serving?</h3>
        <div className="form-row">
          <button className="btn btn-primary btn-full" onClick={() => { setServer(1); setPhase('service') }}>{p1Name}</button>
          <button className="btn btn-primary btn-full" onClick={() => { setServer(2); setPhase('service') }}>{p2Name}</button>
        </div>
      </div>
    )
  }

  // SERVICE
  if (phase === 'service') {
    const serveNum = firstServe ? '1st' : '2nd'
    const serverName = server === 1 ? p1Name : p2Name
    return (
      <div className="track-page">
        <h1>Live Tracker</h1>
        <ScoreCard />
        <PointDisplay />
        <div className="track-phase-bar">
          <span className="phase-tab active">{serveNum} SERVICE</span>
          {history.length > 0 && <button className="btn btn-outline btn-sm" onClick={undo}>Undo</button>}
        </div>
        <p><strong>{serverName}</strong> is serving ({serveNum} serve)</p>
        <div className="form-grid track-buttons">
          <button className="btn btn-primary" onClick={() => recordServe('ace')}>Ace</button>
          <button className="btn btn-outline" onClick={() => recordServe('fault')}>Fault</button>
          <button className="btn btn-error" onClick={() => {
            saveHistory()
            const returner = server === 1 ? 2 : 1
            const rKey = returner === 1 ? 'player1' : 'player2'
            setStats((prev) => {
              const n = JSON.parse(JSON.stringify(prev))
              n[rKey].winners++
              n[rKey].return_attempts++
              n[rKey].returns_in++
              return n
            })
            awardPoint(returner)
          }}>Return Winner</button>
          <button className="btn btn-primary" onClick={() => recordServe('return_error')}>Return Error</button>
        </div>
        <button className="btn btn-primary btn-full" style={{ marginTop: '0.75rem' }} onClick={() => recordServe('in_court')}>Ball in Court</button>
        <hr />
        <button className="btn btn-outline btn-full" onClick={() => setPhase('match_complete')}>End Match</button>
      </div>
    )
  }

  // SELECT POINT WINNER
  if (phase === 'select_point_winner') {
    return (
      <div className="track-page">
        <h1>Live Tracker</h1>
        <ScoreCard />
        <PointDisplay />
        <div className="track-phase-bar">
          <span className="phase-tab">SERVICE</span>
          <span className="phase-tab active">POINT</span>
          {history.length > 0 && <button className="btn btn-outline btn-sm" onClick={undo}>Undo</button>}
        </div>
        <h3>Who won the point?</h3>
        <div className="form-row">
          <button className="btn btn-primary btn-full" onClick={() => { setPendingPointWinner(1); setPhase('point') }}>{p1Name}</button>
          <button className="btn btn-primary btn-full" onClick={() => { setPendingPointWinner(2); setPhase('point') }}>{p2Name}</button>
        </div>
        <hr />
        <button className="btn btn-outline btn-full" onClick={() => setPhase('match_complete')}>End Match</button>
      </div>
    )
  }

  // POINT
  if (phase === 'point') {
    const isWinner = (playerNum) => pendingPointWinner === playerNum

    const PlayerButtons = ({ playerNum, name }) => (
      <div className="track-player-buttons">
        <h4>{name}</h4>
        {isWinner(playerNum) ? (
          <>
            <p style={{ marginBottom: '0.5rem', color: 'white' }}>Clean Winner</p>
            <div className="track-btn-row">
              {['forehand', 'backhand', 'net'].map((s) => (
                <button key={s} className="btn btn-primary btn-sm" onClick={() => recordPointResult(playerNum, 'winner', s)}>{s === 'forehand' ? 'FH' : s === 'backhand' ? 'BH' : 'Net'}</button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p style={{ marginBottom: '0.5rem', color: 'white' }}>Forced Error</p>
            <div className="track-btn-row" style={{ marginBottom: '1.25rem' }}>
              {['forehand', 'backhand', 'net'].map((s) => (
                <button key={s} className="btn btn-error btn-sm" onClick={() => recordPointResult(playerNum, 'forced_error', s)}>{s === 'forehand' ? 'FH' : s === 'backhand' ? 'BH' : 'Net'}</button>
              ))}
            </div>
            <p style={{ marginBottom: '0.5rem', color: 'white' }}>Unforced Error</p>
            <div className="track-btn-row">
              {['forehand', 'backhand', 'net'].map((s) => (
                <button key={s} className="btn btn-error btn-sm" onClick={() => recordPointResult(playerNum, 'unforced_error', s)}>{s === 'forehand' ? 'FH' : s === 'backhand' ? 'BH' : 'Net'}</button>
              ))}
            </div>
          </>
        )}
      </div>
    )

    return (
      <div className="track-page">
        <h1>Live Tracker</h1>
        <ScoreCard />
        <PointDisplay />
        <div className="track-phase-bar">
          <span className="phase-tab">SERVICE</span>
          <span className="phase-tab active">POINT</span>
          {history.length > 0 && <button className="btn btn-outline btn-sm" onClick={undo}>Undo</button>}
        </div>
        <h3>How did the point end?</h3>
        <div>
          <PlayerButtons playerNum={1} name={p1Name} />
          <PlayerButtons playerNum={2} name={p2Name} />
        </div>
        <hr />
        <button className="btn btn-outline btn-full" onClick={() => setPhase('match_complete')}>End Match</button>
      </div>
    )
  }

  // MATCH COMPLETE
  if (phase === 'match_complete') {
    const winner = p1Sets > p2Sets ? p1Name : p2Name
    const s1 = stats.player1, s2 = stats.player2
    const fs1 = s1.first_serves_total > 0 ? `${Math.round(s1.first_serves_in / s1.first_serves_total * 100)}%` : '-'
    const fs2 = s2.first_serves_total > 0 ? `${Math.round(s2.first_serves_in / s2.first_serves_total * 100)}%` : '-'

    const statRows = [
      ['Aces', s1.aces, s2.aces], ['Double Faults', s1.double_faults, s2.double_faults],
      ['1st Serve %', fs1, fs2], ['Winners', s1.winners, s2.winners],
      ['Forced Errors', s1.forced_errors, s2.forced_errors],
      ['Unforced Errors', s1.unforced_errors, s2.unforced_errors],
      ['Points Won', s1.points_won, s2.points_won],
    ]

    return (
      <div className="track-page">
        <h1>Live Tracker</h1>
        <div className="match-complete-banner">
          <h2>Match Complete!</h2>
          <h1>{winner} Wins!</h1>
        </div>
        <div className="track-score-card">
          <div className="track-player-row">
            <span className="track-player-name">{p1Name}</span>
            <div className="track-set-scores">
              {p1Games.map((g, i) => <span key={i} className="set-score">{g}</span>)}
            </div>
            <span className="track-sets">{p1Sets}</span>
          </div>
          <div className="track-player-row">
            <span className="track-player-name">{p2Name}</span>
            <div className="track-set-scores">
              {p2Games.map((g, i) => <span key={i} className="set-score">{g}</span>)}
            </div>
            <span className="track-sets">{p2Sets}</span>
          </div>
        </div>

        <h2>Match Statistics</h2>
        <div className="stats-table">
          <div className="stats-table-header">
            <span>{p1Name}</span><span>Stat</span><span>{p2Name}</span>
          </div>
          {statRows.map(([label, v1, v2]) => (
            <div key={label} className="stats-table-row">
              <span>{v1}</span><span>{label}</span><span>{v2}</span>
            </div>
          ))}
        </div>

        <hr />
        <h2>Save to Match Log</h2>
        <div className="form-group">
          <label>Match Description <span style={{ color: '#ef4444' }}>*</span></label>
          <textarea rows="3" value={matchDescription} onChange={(e) => { setMatchDescription(e.target.value); setSaveError('') }} placeholder="Key moments, turning points..." />
        </div>
        <div className="form-group">
          <label>Mental Game <span style={{ color: '#ef4444' }}>*</span></label>
          <textarea rows="3" value={mentalGame} onChange={(e) => { setMentalGame(e.target.value); setSaveError('') }} placeholder="How did you feel?" />
        </div>
        {saveError && <div className="alert alert-error">{saveError}</div>}
        <button className="btn btn-primary btn-full" onClick={handleSave}>Save to Match Log</button>
        {saveMsg && <div className="alert alert-success">{saveMsg}</div>}
        <hr />
        <button className="btn btn-outline btn-full" onClick={resetMatch}>Start New Match</button>
      </div>
    )
  }

  return null
}
