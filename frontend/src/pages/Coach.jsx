import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../api/client'

const LOWER_IS_BETTER = ['Unforced Errors', 'Double Faults']

function getProgress(goalName, current, target) {
  if (target == null || current == null) return 0
  if (LOWER_IS_BETTER.includes(goalName)) {
    if (current <= target) return 100
    return Math.min(100, Math.max(0, Math.round((1 - (current - target) / current) * 100)))
  }
  if (target === 0) return 0
  return Math.min(100, Math.round((current / target) * 100))
}

function getCurrentValue(trend) {
  if (!trend || !trend.values) return null
  for (let i = trend.values.length - 1; i >= 0; i--) {
    if (trend.values[i] != null) return trend.values[i]
  }
  return null
}

function parseComment(val) {
  if (typeof val === 'string') return { text: val, date: null }
  if (val && typeof val === 'object') return { text: val.text || '', date: val.date || null }
  return { text: '', date: null }
}

function formatMatchDate(dateStr) {
  if (!dateStr) return 'Unknown Date'
  const d = new Date(dateStr)
  if (isNaN(d)) return dateStr
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function Coach() {
  const [goals, setGoals] = useState({})
  const [goalTrends, setGoalTrends] = useState({})
  const [coachFeedback, setCoachFeedback] = useState([])
  const [sharerUsernames, setSharerUsernames] = useState([])
  const [isCoach, setIsCoach] = useState(false)
  const [selectedPlayer, setSelectedPlayer] = useState('')
  const [playerGoals, setPlayerGoals] = useState({})
  const [playerTrends, setPlayerTrends] = useState({})
  const [, setPlayerComments] = useState({})
  const [playerShareId, setPlayerShareId] = useState(null)
  const [draftComments, setDraftComments] = useState({})
  const [saveMsg, setSaveMsg] = useState('')
  const [trainingPlan, setTrainingPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sharedMatchesCoach, setSharedMatchesCoach] = useState([])
  const [sharedMatchesPlayer, setSharedMatchesPlayer] = useState([])
  const [matchDrafts, setMatchDrafts] = useState({})
  const [matchSaveMsg, setMatchSaveMsg] = useState({})
  const [playerTrainingPlan, setPlayerTrainingPlan] = useState(null)
  const [trainingDraft, setTrainingDraft] = useState('')
  const [trainingFeedbackMsg, setTrainingFeedbackMsg] = useState('')

  useEffect(() => {
    Promise.all([
      api.get('/stats/goals').catch(() => ({ data: {} })),
      api.get('/stats').catch(() => ({ data: {} })),
      api.get('/stats/my-coaches').catch(() => ({ data: {} })),
      api.get('/stats/shared').catch(() => ({ data: {} })),
      api.get('/stats/training-plan').catch(() => ({ data: {} })),
      api.get('/stats/shared-matches').catch(() => ({ data: {} })),
    ]).then(([goalsRes, statsRes, coachesRes, sharedRes, planRes, sharedMatchesRes]) => {
      setGoals(goalsRes.data.goals || {})
      setGoalTrends(statsRes.data.goal_trends || {})
      setCoachFeedback(coachesRes.data.coaches || [])
      const sharers = sharedRes.data.sharer_usernames || []
      setSharerUsernames(sharers)
      setIsCoach(sharers.length >= 2)
      setTrainingPlan(planRes.data.training_plan || null)
      setSharedMatchesCoach(sharedMatchesRes.data.as_coach || [])
      setSharedMatchesPlayer(sharedMatchesRes.data.as_player || [])
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedPlayer) return
    api.get(`/stats/shared?user=${selectedPlayer}`).then((res) => {
      setPlayerGoals(res.data.goals || {})
      setPlayerTrends(res.data.goal_trends || {})
      setPlayerComments(res.data.goal_comments || {})
      setPlayerShareId(res.data.share_id)
      setPlayerTrainingPlan(res.data.training_plan || null)
      // Extract plain text for editing from potentially timestamped comments
      const raw = res.data.goal_comments || {}
      const texts = {}
      for (const [k, v] of Object.entries(raw)) {
        const parsed = parseComment(v)
        if (parsed.text) texts[k] = parsed.text
      }
      setDraftComments(texts)
      setTrainingDraft('')
      setTrainingFeedbackMsg('')
    }).catch(() => {})
  }, [selectedPlayer])

  const saveFeedback = async () => {
    if (!playerShareId) return
    try {
      await api.put('/stats/comments', {
        share_id: playerShareId,
        goal_comments: draftComments,
      })
      setSaveMsg('Feedback saved!')
      setTimeout(() => setSaveMsg(''), 3000)
    } catch {
      setSaveMsg('Failed to save feedback')
    }
  }

  const dismissFeedback = async (shareId, goalName, coachUsername) => {
    try {
      await api.put('/stats/dismiss-feedback', { share_id: shareId, goal_name: goalName })
      setCoachFeedback((prev) =>
        prev.map((c) => {
          if (c.coach_username !== coachUsername) return c
          const updated = { ...c.goal_comments }
          delete updated[goalName]
          return { ...c, goal_comments: updated }
        })
      )
    } catch { /* ignore */ }
  }

  const getFeedbackForGoal = (goalName) => {
    const comments = []
    for (const coach of coachFeedback) {
      if (coach.goal_comments && coach.goal_comments[goalName]) {
        const parsed = parseComment(coach.goal_comments[goalName])
        if (parsed.text) {
          comments.push({
            coach: coach.coach_username,
            comment: parsed.text,
            date: parsed.date,
            shareId: coach.share_id,
          })
        }
      }
    }
    return comments
  }

  const dismissMatchFeedback = async (matchId) => {
    try {
      await api.put('/stats/dismiss-match-feedback', { shared_match_id: matchId })
      setSharedMatchesPlayer((prev) => prev.filter((m) => m.id !== matchId))
    } catch { /* ignore */ }
  }

  const saveMatchFeedback = async (matchId) => {
    const feedback = matchDrafts[matchId] || ''
    try {
      await api.put('/stats/match-feedback', {
        shared_match_id: matchId,
        feedback,
      })
      setMatchSaveMsg((prev) => ({ ...prev, [matchId]: 'Saved!' }))
      setSharedMatchesCoach((prev) =>
        prev.map((m) => m.id === matchId ? { ...m, feedback, feedback_date: new Date().toISOString().split('T')[0] } : m)
      )
      setTimeout(() => setMatchSaveMsg((prev) => ({ ...prev, [matchId]: '' })), 3000)
    } catch {
      setMatchSaveMsg((prev) => ({ ...prev, [matchId]: 'Failed to save' }))
    }
  }

  const saveTrainingFeedback = async () => {
    if (!playerShareId) return
    try {
      await api.put('/stats/training-plan-feedback', {
        share_id: playerShareId,
        feedback: trainingDraft,
      })
      setTrainingFeedbackMsg('Feedback saved!')
      setTimeout(() => setTrainingFeedbackMsg(''), 3000)
    } catch {
      setTrainingFeedbackMsg('Failed to save feedback')
    }
  }

  const dismissTrainingFeedback = async (shareId, coachUsername) => {
    try {
      await api.put('/stats/dismiss-training-feedback', { share_id: shareId })
      setCoachFeedback((prev) =>
        prev.map((c) => {
          if (c.coach_username !== coachUsername) return c
          return { ...c, general_comment: {} }
        })
      )
    } catch { /* ignore */ }
  }

  if (loading) return <div className="loading">Loading...</div>

  const goalNames = Object.keys(goals)

  const coachMatchesFiltered = selectedPlayer
    ? sharedMatchesCoach.filter((m) => m.sharer === selectedPlayer)
    : sharedMatchesCoach

  return (
    <div className="coach-page">
      <h1>Coach Hub</h1>

      {/* Player View */}
      <div className="coach-info-banner">
        <p>These are your progress goals from the Stats page. Your coach can provide guidance here.</p>
        <Link to="/stats">Manage in Stats &rarr;</Link>
      </div>

      {goalNames.length === 0 ? (
        <p style={{ color: 'var(--muted-text)', marginTop: '2rem' }}>
          No progress goals set yet. <Link to="/stats">Set goals in Stats</Link> to get started.
        </p>
      ) : (
        <div className="coach-goals-grid">
          {goalNames.map((name) => {
            const trend = goalTrends[name]
            const target = goals[name]
            const current = getCurrentValue(trend)
            const progress = getProgress(name, current, target)
            const toGo = LOWER_IS_BETTER.includes(name)
              ? (current != null ? Math.max(0, current - target) : null)
              : (current != null ? Math.max(0, target - current) : null)
            const feedback = getFeedbackForGoal(name)

            return (
              <div key={name} className="coach-goal-card">
                <div className="coach-goal-header">
                  <h3>{name}</h3>
                  <span className="badge" style={{ background: progress >= 100 ? '#22c55e' : 'rgba(34,197,94,0.2)', color: progress >= 100 ? 'white' : '#22c55e' }}>
                    {progress}%
                  </span>
                </div>
                <div className="coach-goal-stats">
                  <div>
                    <span className="coach-stat-label">CURRENT</span>
                    <span className="coach-stat-value">{current != null ? Math.round(current * 10) / 10 : '—'}</span>
                  </div>
                  <div>
                    <span className="coach-stat-label">TARGET</span>
                    <span className="coach-stat-value">{target}</span>
                  </div>
                  <div>
                    <span className="coach-stat-label">TO GO</span>
                    <span className="coach-stat-value">{toGo != null ? Math.round(toGo * 10) / 10 : '—'}</span>
                  </div>
                </div>
                <div className="progress-bar-track">
                  <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                </div>
                {feedback.length > 0 && (
                  <div className="coach-feedback-section">
                    <h4>Coach Notes & Guidance</h4>
                    {feedback.map((f, i) => (
                      <div key={i} className="coach-feedback-item">
                        <div className="coach-feedback-header">
                          <div>
                            <strong>{f.coach}</strong>
                            {f.date && <span className="coach-feedback-date">{f.date}</span>}
                          </div>
                          <button
                            className="coach-dismiss-btn"
                            title="Mark as done"
                            onClick={() => dismissFeedback(f.shareId, name, f.coach)}
                          >
                            &#10003;
                          </button>
                        </div>
                        <p>{f.comment}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Player Match Feedback Section */}
      {sharedMatchesPlayer.length > 0 && (
        <>
          <hr />
          <h2>Match Feedback</h2>
          <p style={{ color: 'var(--secondary-text)', marginBottom: '1rem' }}>
            Feedback from your coach on matches you shared.
          </p>
          <div className="coach-matches-grid">
            {sharedMatchesPlayer.map((sm) => {
              const md = sm.match_data || {}
              const matchKey = sm.match_key || ''
              const parts = matchKey.split('|')
              const matchDate = parts[0] || ''
              const oppName = md['Opp. Name'] || parts[1] || 'Unknown'
              const isWin = md.Result === 'W'

              return (
                <div key={sm.id} className="coach-match-card">
                  <div className="coach-match-header">
                    <div>
                      <span className="match-card-date" style={{ fontSize: '0.75rem' }}>{formatMatchDate(matchDate)}</span>
                      <h3 style={{ margin: '0.25rem 0' }}>vs {oppName}</h3>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      {md.Result && (
                        <span className={`badge ${isWin ? 'badge-win' : 'badge-loss'}`} style={{ fontSize: '0.7rem' }}>
                          {isWin ? 'WIN' : 'LOSS'}
                        </span>
                      )}
                      {md['Match Score'] && <span className="match-card-score" style={{ fontSize: '0.85rem', display: 'block' }}>{md['Match Score']}</span>}
                    </div>
                  </div>
                  <div className="match-card-stats-scroll">
                    <div className="match-card-stats">
                      <Stat label="1st Serve %" value={md['First Serve %']} suffix="%" />
                      <Stat label="1st Serve Won" value={md['First Serve % Won']} suffix="%" />
                      <Stat label="2nd Serve %" value={md['Second Serve %']} suffix="%" />
                      <Stat label="Aces" value={md.Aces} />
                      <Stat label="Double Faults" value={md['Double Faults']} />
                      <Stat label="Serve Speed" value={md['Serve Speed']} />
                      <Stat label="Serve Placement" value={md['Serve Placement']} />
                      <Stat label="Return %" value={md['Return %']} suffix="%" />
                      <Stat label="Return Placement" value={md['Return Placement']} />
                      <Stat label="Winners" value={md.Winners} />
                      <Stat label="Unforced Errors" value={md['Unforced Errors']} />
                      <Stat label="Forced Errors" value={md['Forced Errors']} />
                      <Stat label="Net Pts Won" value={md['Net Points Won']} />
                      <Stat label="Break Pts Won" value={md['Break Points Won']} />
                      <Stat label="Break Pts Saved" value={md['Break Points Saved']} />
                      <Stat label="Avg Rally Len" value={md['Average Rally Length']} />
                      <Stat label="Points Won" value={md['Points Won']} />
                      <Stat label="Mental Game" value={md['Mental Game']} />
                      <Stat label="UTR" value={md.UTR} />
                    </div>
                  </div>
                  <div className="coach-match-feedback-display">
                    <div className="coach-feedback-header">
                      <h4>Coach Feedback</h4>
                      <button
                        className="coach-dismiss-btn"
                        title="Mark as done"
                        onClick={() => dismissMatchFeedback(sm.id)}
                      >
                        &#10003;
                      </button>
                    </div>
                    <p>{sm.feedback}</p>
                    <span className="coach-feedback-date">
                      {sm.sharee} &middot; {sm.feedback_date}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Training Plan */}
      {trainingPlan && (
        <>
          <hr />
          <div className="coach-goal-card" style={{ maxWidth: '100%' }}>
            <div className="coach-goal-header">
              <h3>Your Training Plan</h3>
              <span className="badge" style={{ background: 'rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '0.7rem' }}>Generated by MatchGenie</span>
            </div>
            <div className="training-plan-content" dangerouslySetInnerHTML={{ __html: formatTrainingPlan(trainingPlan) }} />
            {coachFeedback.some((c) => c.general_comment && c.general_comment.text) && (
              <div className="coach-feedback-section">
                <h4>Coach Notes on Training Plan</h4>
                {coachFeedback.filter((c) => c.general_comment && c.general_comment.text).map((c) => (
                  <div key={c.share_id} className="coach-feedback-item">
                    <div className="coach-feedback-header">
                      <div>
                        <strong>{c.coach_username}</strong>
                        {c.general_comment.date && <span className="coach-feedback-date">{c.general_comment.date}</span>}
                      </div>
                      <button
                        className="coach-dismiss-btn"
                        title="Mark as done"
                        onClick={() => dismissTrainingFeedback(c.share_id, c.coach_username)}
                      >
                        &#10003;
                      </button>
                    </div>
                    <p>{c.general_comment.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Coach View */}
      {isCoach && (
        <>
          <hr />
          <h2>Your Players</h2>
          <div className="form-group" style={{ maxWidth: '300px' }}>
            <select value={selectedPlayer} onChange={(e) => { setSelectedPlayer(e.target.value); setSaveMsg('') }}>
              <option value="">Select a player...</option>
              {sharerUsernames.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          {selectedPlayer && Object.keys(playerGoals).length > 0 && (
            <div className="coach-goals-grid">
              {Object.keys(playerGoals).map((name) => {
                const trend = playerTrends[name]
                const target = playerGoals[name]
                const current = getCurrentValue(trend)
                const progress = getProgress(name, current, target)
                const toGo = LOWER_IS_BETTER.includes(name)
                  ? (current != null ? Math.max(0, current - target) : null)
                  : (current != null ? Math.max(0, target - current) : null)

                return (
                  <div key={name} className="coach-goal-card">
                    <div className="coach-goal-header">
                      <h3>{name}</h3>
                      <span className="badge" style={{ background: progress >= 100 ? '#22c55e' : 'rgba(34,197,94,0.2)', color: progress >= 100 ? 'white' : '#22c55e' }}>
                        {progress}%
                      </span>
                    </div>
                    <div className="coach-goal-stats">
                      <div>
                        <span className="coach-stat-label">CURRENT</span>
                        <span className="coach-stat-value">{current != null ? Math.round(current * 10) / 10 : '—'}</span>
                      </div>
                      <div>
                        <span className="coach-stat-label">TARGET</span>
                        <span className="coach-stat-value">{target}</span>
                      </div>
                      <div>
                        <span className="coach-stat-label">TO GO</span>
                        <span className="coach-stat-value">{toGo != null ? Math.round(toGo * 10) / 10 : '—'}</span>
                      </div>
                    </div>
                    <div className="progress-bar-track">
                      <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="coach-feedback-section">
                      <h4>Your Feedback</h4>
                      <textarea
                        className="coach-comment-input"
                        rows="3"
                        placeholder="Leave feedback for this player..."
                        value={draftComments[name] || ''}
                        onChange={(e) => setDraftComments((prev) => ({ ...prev, [name]: e.target.value }))}
                      />
                    </div>
                  </div>
                )
              })}
              <div style={{ gridColumn: '1 / -1' }}>
                <button className="btn btn-coach" onClick={saveFeedback}>Save Feedback</button>
                {saveMsg && <span className="alert alert-success" style={{ marginLeft: '1rem', display: 'inline-block' }}>{saveMsg}</span>}
              </div>
            </div>
          )}

          {selectedPlayer && Object.keys(playerGoals).length === 0 && (
            <p style={{ color: 'var(--muted-text)' }}>This player has no progress goals set.</p>
          )}

          {/* Coach: Player Training Plan */}
          {selectedPlayer && playerTrainingPlan && (
            <>
              <hr />
              <div className="coach-goal-card" style={{ maxWidth: '100%' }}>
                <div className="coach-goal-header">
                  <h3>{selectedPlayer}&apos;s Training Plan</h3>
                  <span className="badge" style={{ background: 'rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '0.7rem' }}>Generated by MatchGenie</span>
                </div>
                <div className="training-plan-content" dangerouslySetInnerHTML={{ __html: formatTrainingPlan(playerTrainingPlan) }} />
                <div className="coach-feedback-section">
                  <h4>Your Feedback</h4>
                  <textarea
                    className="coach-comment-input"
                    rows="3"
                    placeholder="Leave feedback on this training plan..."
                    value={trainingDraft}
                    onChange={(e) => setTrainingDraft(e.target.value)}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
                    <button className="btn btn-coach btn-sm" onClick={saveTrainingFeedback}>Save Feedback</button>
                    {trainingFeedbackMsg && (
                      <span style={{ fontSize: '0.8rem', color: trainingFeedbackMsg === 'Feedback saved!' ? 'var(--accent-color)' : 'var(--danger-color)' }}>
                        {trainingFeedbackMsg}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Coach: Shared Matches */}
          {selectedPlayer && coachMatchesFiltered.length > 0 && (
            <>
              <hr />
              <h2>Shared Matches{selectedPlayer ? ` from ${selectedPlayer}` : ''}</h2>
              <p style={{ color: 'var(--secondary-text)', marginBottom: '1rem' }}>
                Matches shared with you for review. Provide feedback for each match.
              </p>
              <div className="coach-matches-grid">
                {coachMatchesFiltered.map((sm) => {
                  const md = sm.match_data || {}
                  const matchKey = sm.match_key || ''
                  const parts = matchKey.split('|')
                  const matchDate = parts[0] || ''
                  const oppName = md['Opp. Name'] || parts[1] || 'Unknown'
                  const isWin = md.Result === 'W'

                  return (
                    <div key={sm.id} className="coach-match-card">
                      <div className="coach-match-header">
                        <div>
                          <span className="match-card-date" style={{ fontSize: '0.75rem' }}>{formatMatchDate(matchDate)}</span>
                          <h3 style={{ margin: '0.25rem 0' }}>vs {oppName}</h3>
                          {!selectedPlayer && <span style={{ fontSize: '0.75rem', color: 'var(--muted-text)' }}>Player: {sm.sharer}</span>}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {md.Result && (
                            <span className={`badge ${isWin ? 'badge-win' : 'badge-loss'}`} style={{ fontSize: '0.7rem' }}>
                              {isWin ? 'WIN' : 'LOSS'}
                            </span>
                          )}
                          {md['Match Score'] && <span className="match-card-score" style={{ fontSize: '0.85rem', display: 'block' }}>{md['Match Score']}</span>}
                        </div>
                      </div>

                      <div className="match-card-stats-scroll">
                        <div className="match-card-stats">
                          <Stat label="1st Serve %" value={md['First Serve %']} suffix="%" />
                          <Stat label="1st Serve Won" value={md['First Serve % Won']} suffix="%" />
                          <Stat label="2nd Serve %" value={md['Second Serve %']} suffix="%" />
                          <Stat label="Aces" value={md.Aces} />
                          <Stat label="Double Faults" value={md['Double Faults']} />
                          <Stat label="Serve Speed" value={md['Serve Speed']} />
                          <Stat label="Serve Placement" value={md['Serve Placement']} />
                          <Stat label="Return %" value={md['Return %']} suffix="%" />
                          <Stat label="Return Placement" value={md['Return Placement']} />
                          <Stat label="Winners" value={md.Winners} />
                          <Stat label="Unforced Errors" value={md['Unforced Errors']} />
                          <Stat label="Forced Errors" value={md['Forced Errors']} />
                          <Stat label="Net Pts Won" value={md['Net Points Won']} />
                          <Stat label="Break Pts Won" value={md['Break Points Won']} />
                          <Stat label="Break Pts Saved" value={md['Break Points Saved']} />
                          <Stat label="Avg Rally Len" value={md['Average Rally Length']} />
                          <Stat label="Points Won" value={md['Points Won']} />
                          <Stat label="Mental Game" value={md['Mental Game']} />
                          <Stat label="UTR" value={md.UTR} />
                        </div>
                      </div>

                      <div className="coach-match-feedback-area">
                        <h4>Your Feedback</h4>
                        <textarea
                          className="coach-comment-input"
                          rows="3"
                          placeholder="Write feedback on this match..."
                          value={matchDrafts[sm.id] !== undefined ? matchDrafts[sm.id] : (sm.feedback || '')}
                          onChange={(e) => setMatchDrafts((prev) => ({ ...prev, [sm.id]: e.target.value }))}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
                          <button className="btn btn-coach btn-sm" onClick={() => saveMatchFeedback(sm.id)}>
                            Save Feedback
                          </button>
                          {matchSaveMsg[sm.id] && (
                            <span style={{ fontSize: '0.8rem', color: matchSaveMsg[sm.id] === 'Saved!' ? 'var(--accent-color)' : 'var(--danger-color)' }}>
                              {matchSaveMsg[sm.id]}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function formatTrainingPlan(text) {
  if (!text) return ''

  const lines = text.split('\n')
  const tokens = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Detect markdown table
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      if (tableLines.length >= 2) {
        let html = '<table class="tp-table">'
        const headerCells = tableLines[0].split('|').filter(Boolean).map((c) => c.trim())
        html += '<thead><tr>' + headerCells.map((c) => `<th>${applyInline(c)}</th>`).join('') + '</tr></thead>'
        const startRow = tableLines[1].trim().match(/^\|[\s\-:]+\|/) ? 2 : 1
        html += '<tbody>'
        for (let r = startRow; r < tableLines.length; r++) {
          const cells = tableLines[r].split('|').filter(Boolean).map((c) => c.trim())
          html += '<tr>' + cells.map((c) => `<td>${applyInline(c)}</td>`).join('') + '</tr>'
        }
        html += '</tbody></table>'
        tokens.push({ type: 'html', value: html })
      } else {
        tableLines.forEach((l) => tokens.push({ type: 'text', value: l }))
      }
    } else {
      const trimmed = line.trim()
      if (trimmed === '') {
        tokens.push({ type: 'blank' })
      } else if (trimmed.match(/^#{1,3}\s/)) {
        const level = trimmed.match(/^(#{1,3})\s/)[1].length
        tokens.push({ type: 'heading', level, value: applyInline(trimmed.replace(/^#{1,3}\s/, '')) })
      } else if (trimmed.match(/^- /)) {
        tokens.push({ type: 'ul', value: applyInline(trimmed.slice(2)) })
      } else if (trimmed.match(/^\d+\.\s/)) {
        tokens.push({ type: 'ol', value: applyInline(trimmed.replace(/^\d+\.\s/, '')) })
      } else {
        tokens.push({ type: 'text', value: applyInline(trimmed) })
      }
      i++
    }
  }

  // Group consecutive list items into <ul>/<ol> and wrap sections
  let html = ''
  let j = 0
  while (j < tokens.length) {
    const t = tokens[j]
    if (t.type === 'html') {
      html += t.value
      j++
    } else if (t.type === 'heading') {
      const tag = `h${t.level}`
      html += `<${tag}>${t.value}</${tag}>`
      j++
    } else if (t.type === 'ul') {
      html += '<ul>'
      while (j < tokens.length && tokens[j].type === 'ul') {
        html += `<li>${tokens[j].value}</li>`
        j++
      }
      html += '</ul>'
    } else if (t.type === 'ol') {
      html += '<ol>'
      while (j < tokens.length && tokens[j].type === 'ol') {
        html += `<li>${tokens[j].value}</li>`
        j++
      }
      html += '</ol>'
    } else if (t.type === 'blank') {
      j++
    } else {
      html += `<p>${t.value}</p>`
      j++
    }
  }

  return html
}

function applyInline(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
}

function Stat({ label, value, suffix = '' }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="match-stat">
      <span className="match-stat-value">{value}{suffix}</span>
      <span className="match-stat-label">{label}</span>
    </div>
  )
}
