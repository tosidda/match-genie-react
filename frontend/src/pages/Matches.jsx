import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'

const MATCHES_PER_PAGE = 10

const EDIT_FIELDS = [
  { key: 'match_date', label: 'Match Date', sheetKey: 'Match Date', type: 'date' },
  { key: 'opponent_name', label: 'Opponent', sheetKey: 'Opp. Name', type: 'text' },
  { key: 'result', label: 'Result', sheetKey: 'Result', type: 'select', options: ['W', 'L'] },
  { key: 'match_score', label: 'Score', sheetKey: 'Match Score', type: 'text' },
  { key: 'surface_type', label: 'Surface', sheetKey: 'Surface Type', type: 'select', options: ['Hard', 'Clay', 'Grass', 'Indoor'] },
  { key: 'utr', label: 'UTR', sheetKey: 'UTR', type: 'text' },
  { key: 'match_description', label: 'Notes', sheetKey: 'Match Description', type: 'textarea' },
  { key: 'first_serve_percentage', label: '1st Serve %', sheetKey: 'First Serve %', type: 'number' },
  { key: 'first_serve_percentage_won', label: '1st Serve Won %', sheetKey: 'First Serve % Won', type: 'number' },
  { key: 'second_serve_percentage', label: '2nd Serve %', sheetKey: 'Second Serve %', type: 'number' },
  { key: 'aces', label: 'Aces', sheetKey: 'Aces', type: 'number' },
  { key: 'double_faults', label: 'Double Faults', sheetKey: 'Double Faults', type: 'number' },
  { key: 'serve_speed', label: 'Serve Speed', sheetKey: 'Serve Speed', type: 'number' },
  { key: 'serve_placement', label: 'Serve Placement', sheetKey: 'Serve Placement', type: 'text' },
  { key: 'return_percentage', label: 'Return %', sheetKey: 'Return %', type: 'number' },
  { key: 'return_placement', label: 'Return Placement', sheetKey: 'Return Placement', type: 'text' },
  { key: 'winners', label: 'Winners', sheetKey: 'Winners', type: 'number' },
  { key: 'unforced_errors', label: 'Unforced Errors', sheetKey: 'Unforced Errors', type: 'number' },
  { key: 'forced_errors', label: 'Forced Errors', sheetKey: 'Forced Errors', type: 'number' },
  { key: 'net_points_won', label: 'Net Pts Won', sheetKey: 'Net Points Won', type: 'number' },
  { key: 'break_points_won', label: 'Break Pts Won', sheetKey: 'Break Points Won', type: 'number' },
  { key: 'break_points_saved', label: 'Break Pts Saved', sheetKey: 'Break Points Saved', type: 'number' },
  { key: 'average_rally_length', label: 'Avg Rally Length', sheetKey: 'Average Rally Length', type: 'number' },
  { key: 'mental_game', label: 'Mental Game', sheetKey: 'Mental Game', type: 'text' },
]

function buildEditForm(match) {
  const form = {}
  for (const f of EDIT_FIELDS) {
    const raw = match[f.sheetKey]
    form[f.key] = raw === undefined || raw === null ? '' : String(raw)
  }
  return form
}

export default function Matches() {
  const navigate = useNavigate()
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [resultFilter, setResultFilter] = useState('all')
  const [surfaceFilter, setSurfaceFilter] = useState('all')
  const [timeFilter, setTimeFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [videoAnalysisOnly, setVideoAnalysisOnly] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [shareModal, setShareModal] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [shareUsername, setShareUsername] = useState('')
  const [sharing, setSharing] = useState(false)
  const [shareMsg, setShareMsg] = useState('')

  const [editModal, setEditModal] = useState(null)  // { match, form }
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState('')

  const [deleteModal, setDeleteModal] = useState(null)  // match
  const [deleting, setDeleting] = useState(false)

  const loadMatches = async () => {
    const res = await api.get('/matches')
    setMatches(res.data.matches || [])
  }

  useEffect(() => {
    loadMatches().catch(() => {}).finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    let list = [...matches]

    if (resultFilter === 'wins') list = list.filter((m) => m.Result === 'W')
    else if (resultFilter === 'losses') list = list.filter((m) => m.Result === 'L')

    if (surfaceFilter !== 'all') {
      list = list.filter((m) => (m['Surface Type'] || '').toLowerCase() === surfaceFilter)
    }

    if (timeFilter !== 'all') {
      const now = new Date()
      list = list.filter((m) => {
        const d = new Date(m['Match Date'])
        if (isNaN(d)) return false
        const diff = (now - d) / (1000 * 60 * 60 * 24)
        if (timeFilter === '30') return diff <= 30
        if (timeFilter === '90') return diff <= 90
        if (timeFilter === 'year') return d.getFullYear() === now.getFullYear()
        return true
      })
    }

    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((m) =>
        (m['Opp. Name'] || '').toLowerCase().includes(q) ||
        (m['Match Description'] || '').toLowerCase().includes(q)
      )
    }

    if (videoAnalysisOnly) {
      list = list.filter((m) => Boolean(String(m['Analyzed Video Link'] || '').trim()))
    }

    list.sort((a, b) => {
      const dateDiff = new Date(b['Match Date']) - new Date(a['Match Date'])
      if (dateDiff !== 0) return dateDiff
      return matches.indexOf(b) - matches.indexOf(a)
    })
    return list
  }, [matches, resultFilter, surfaceFilter, timeFilter, search, videoAnalysisOnly])

  const totalPages = Math.max(1, Math.ceil(filtered.length / MATCHES_PER_PAGE))
  const paginatedMatches = useMemo(() => {
    const start = (currentPage - 1) * MATCHES_PER_PAGE
    return filtered.slice(start, start + MATCHES_PER_PAGE)
  }, [filtered, currentPage])

  useEffect(() => {
    setCurrentPage(1)
  }, [resultFilter, surfaceFilter, timeFilter, search, videoAnalysisOnly])

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages))
  }, [totalPages])

  const formatDate = (dateStr) => {
    const d = new Date(dateStr)
    if (isNaN(d)) return dateStr || 'Unknown Date'
    return d.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }).toUpperCase()
  }

  const getMatchKey = (match) => {
    const date = match['Match Date'] || ''
    const opp = match['Opp. Name'] || ''
    const d = new Date(date)
    const dateStr = isNaN(d) ? date : d.toISOString().split('T')[0]
    return `${dateStr}|${opp}`
  }

  const openShareModal = (match) => {
    const matchKey = getMatchKey(match)
    setShareModal({ matchKey, matchData: match })
    setShareMsg('')
    setShareUsername('')
    api.get('/stats/share-recipients').then((res) => {
      setRecipients(res.data.recipients || [])
    }).catch(() => setRecipients([]))
  }

  const doShare = async (username) => {
    if (!username.trim() || !shareModal) return
    setSharing(true)
    setShareMsg('')
    try {
      const res = await api.post('/stats/share-match', {
        username: username.trim(),
        match_key: shareModal.matchKey,
        match_data: shareModal.matchData,
      })
      setShareMsg(res.data.message || 'Shared!')
      setTimeout(() => setShareModal(null), 1500)
    } catch (err) {
      setShareMsg(err.response?.data?.error || 'Failed to share')
    } finally {
      setSharing(false)
    }
  }

  const openEditModal = (match) => {
    setEditModal({ match, form: buildEditForm(match) })
    setEditMsg('')
  }

  const handleEditField = (key, value) => {
    setEditModal((prev) => ({ ...prev, form: { ...prev.form, [key]: value } }))
  }

  const saveEdit = async () => {
    if (!editModal) return
    setEditSaving(true)
    setEditMsg('')
    try {
      const rowIndex = editModal.match['_row_index']
      await api.put(`/matches/${rowIndex}`, editModal.form)
      setMatches((prev) => prev.map((m) => {
        if (m['_row_index'] !== rowIndex) return m
        const updated = { ...m }
        for (const f of EDIT_FIELDS) {
          const val = editModal.form[f.key]
          if (val !== '') updated[f.sheetKey] = f.type === 'number' ? Number(val) : val
        }
        return updated
      }))
      setEditModal(null)
    } catch (err) {
      setEditMsg(err.response?.data?.error || 'Failed to save')
    } finally {
      setEditSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteModal) return
    setDeleting(true)
    try {
      const rowIndex = deleteModal['_row_index']
      await api.delete(`/matches/${rowIndex}`)
      await loadMatches()
      setDeleteModal(null)
    } catch (err) {
      console.error(err)
    } finally {
      setDeleting(false)
    }
  }

  const handleAIInsights = (match) => {
    const v = (key) => match[key] ?? 'N/A'
    const opponent = match['Opp. Name'] || 'Unknown'
    const date = match['Match Date'] || ''
    const result = match.Result === 'W' ? 'Win' : 'Loss'
    const score = match['Match Score'] || ''
    const surface = match['Surface Type'] || 'N/A'
    const description = match['Match Description'] || ''

    const playerStats = `First Serve ${v('First Serve %')}%, First Serve Won ${v('First Serve % Won')}%, Second Serve ${v('Second Serve %')}%, Aces ${v('Aces')}, Double Faults ${v('Double Faults')}, Serve Speed ${v('Serve Speed')}, Serve Placement ${v('Serve Placement')}, Return ${v('Return %')}%, Return Placement ${v('Return Placement')}, Winners ${v('Winners')}, Unforced Errors ${v('Unforced Errors')}, Forced Errors ${v('Forced Errors')}, Net Points Won ${v('Net Points Won')}, Break Points Won ${v('Break Points Won')}, Break Points Saved ${v('Break Points Saved')}, Avg Rally Length ${v('Average Rally Length')}, Points Won ${v('Points Won')}, Mental Game ${v('Mental Game')}, UTR ${v('UTR')}`

    const hasOppStats = match['Opp. Points Won'] != null && match['Opp. Points Won'] !== ''
    const oppStats = hasOppStats
      ? ` Opponent stats: First Serve ${v('Opp. First Serve %')}%, First Serve Won ${v('Opp. First Serve % Won')}%, Second Serve ${v('Opp. Second Serve %')}%, Aces ${v('Opp. Aces')}, Double Faults ${v('Opp. Double Faults')}, Return ${v('Opp. Return %')}%, Winners ${v('Opp. Winners')}, Unforced Errors ${v('Opp. Unforced Errors')}, Forced Errors ${v('Opp. Forced Errors')}, Net Points Won ${v('Opp. Net Points Won')}, Break Points Won ${v('Opp. Break Points Won')}, Break Points Saved ${v('Opp. Break Points Saved')}, Points Won ${v('Opp. Points Won')}.`
      : ''

    const prompt = `Analyze my match against ${opponent} on ${date}. Surface: ${surface}. ${description ? `Notes: ${description}. ` : ''}Result: ${result} ${score}. My stats: ${playerStats}.${oppStats} Give me insights on what went well and what I should improve.`

    navigate('/crush', { state: { matchContext: prompt } })
  }

  const openMatchVideo = () => navigate('/video')

  if (loading) return <div className="loading">Loading matches...</div>

  return (
    <div className="matches-page">
      <div className="matches-header">
        <div>
          <h1>My Matches</h1>
          <p>{filtered.length} match{filtered.length !== 1 ? 'es' : ''} found</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button className="btn btn-primary" onClick={() => navigate('/log')}>Log Match</button>
          <button className="btn btn-track" onClick={() => navigate('/track')}>Live Track</button>
        </div>
      </div>

      <div className="matches-filters">
        <select value={resultFilter} onChange={(e) => setResultFilter(e.target.value)}>
          <option value="all">All Results</option>
          <option value="wins">Wins</option>
          <option value="losses">Losses</option>
        </select>
        <select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)}>
          <option value="all">All Surfaces</option>
          <option value="hard">Hard</option>
          <option value="clay">Clay</option>
          <option value="grass">Grass</option>
        </select>
        <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value)}>
          <option value="all">All Time</option>
          <option value="30">Last 30 Days</option>
          <option value="90">Last 90 Days</option>
          <option value="year">This Year</option>
        </select>
        <input
          type="text"
          placeholder="Search opponent or description..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="matches-video-analysis-filter" aria-label="Show only matches with video analysis">
          <input
            type="checkbox"
            checked={videoAnalysisOnly}
            onChange={(e) => setVideoAnalysisOnly(e.target.checked)}
          />
          <span>Matches with Video Analysis</span>
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="matches-empty">
          <p>No matches found. Try adjusting your filters or log a new match.</p>
        </div>
      ) : (
        <div className="matches-list">
          {paginatedMatches.map((match, i) => {
            const isWin = match.Result === 'W'
            return (
              <div key={i} className="match-card">
                <div className="match-card-header">
                  <div className="match-card-left">
                    <span className="match-card-date">{formatDate(match['Match Date'])}</span>
                    <h3 className="match-card-opponent">vs {match['Opp. Name'] || 'Unknown'}</h3>
                    <div className="match-card-meta">
                      {match['Match Description'] && (
                        <span className="match-card-desc">{match['Match Description']}</span>
                      )}
                      {match['Surface Type'] && (
                        <span className="match-card-surface">{match['Surface Type']}</span>
                      )}
                    </div>
                  </div>
                  <div className="match-card-right">
                    <span className={`badge ${isWin ? 'badge-win' : 'badge-loss'}`}>
                      {isWin ? 'WIN' : 'LOSS'}
                    </span>
                    <span className="match-card-score">{match['Match Score'] || ''}</span>
                    <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.25rem' }}>
                      <button
                        className="btn btn-outline btn-sm"
                        title="Edit match"
                        onClick={() => openEditModal(match)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm"
                        title="Delete match"
                        style={{ color: '#ef4444', border: '1px solid #ef4444', background: 'transparent', borderRadius: 'var(--border-radius)' }}
                        onClick={() => setDeleteModal(match)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                <div className="match-card-stats-scroll">
                  <div className="match-card-stats">
                    <Stat label="1st Serve %" value={match['First Serve %']} suffix="%" />
                    <Stat label="1st Serve Won" value={match['First Serve % Won']} suffix="%" />
                    <Stat label="2nd Serve %" value={match['Second Serve %']} suffix="%" />
                    <Stat label="Aces" value={match.Aces} />
                    <Stat label="Double Faults" value={match['Double Faults']} />
                    <Stat label="Serve Speed" value={match['Serve Speed']} />
                    <Stat label="Serve Placement" value={match['Serve Placement']} />
                    <Stat label="Return %" value={match['Return %']} suffix="%" />
                    <Stat label="Return Placement" value={match['Return Placement']} />
                    <Stat label="Winners" value={match.Winners} />
                    <Stat label="Unforced Errors" value={match['Unforced Errors']} />
                    <Stat label="Forced Errors" value={match['Forced Errors']} />
                    <Stat label="Net Pts Won" value={match['Net Points Won']} />
                    <Stat label="Break Pts Won" value={match['Break Points Won']} />
                    <Stat label="Break Pts Saved" value={match['Break Points Saved']} />
                    <Stat label="Avg Rally Len" value={match['Average Rally Length']} />
                    <Stat label="Points Won" value={match['Points Won']} />
                    <Stat label="Mental Game" value={match['Mental Game']} />
                    <Stat label="UTR" value={match.UTR} />
                  </div>
                </div>

                <div className="match-card-actions">
                  {match['Opp. Points Won'] && Number(match['Opp. Points Won']) > 0 && (
                    <button className="btn btn-stats btn-sm" onClick={() => navigate('/stats#h2h')}>
                      View Head to Head
                    </button>
                  )}
                  <button className="btn btn-crush btn-sm" onClick={() => handleAIInsights(match)}>
                    MatchGenie Insights
                  </button>
                  <button className="btn btn-coach btn-sm" onClick={() => openShareModal(match)}>
                    Share
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => openMatchVideo(match)}>
                    Video Analysis Insights
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {filtered.length > MATCHES_PER_PAGE && (
        <nav className="matches-pagination" aria-label="Matches pagination">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
          >
            Previous
          </button>
          <div className="matches-pagination-pages">
            {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
              <button
                key={page}
                type="button"
                className={`matches-page-button ${page === currentPage ? 'active' : ''}`}
                aria-label={`Page ${page}`}
                aria-current={page === currentPage ? 'page' : undefined}
                onClick={() => setCurrentPage(page)}
              >
                {page}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
          >
            Next
          </button>
        </nav>
      )}

      {shareModal && (
        <div className="share-modal-overlay" onClick={() => setShareModal(null)}>
          <div className="share-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Share Match</h3>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '1rem' }}>
              Share this match with your coach or teammate for feedback.
            </p>

            {recipients.length > 0 && (
              <div className="share-recipients">
                <label style={{ fontSize: '0.8rem', color: 'var(--muted-text)', marginBottom: '0.5rem', display: 'block' }}>
                  Previously shared with:
                </label>
                <div className="share-recipients-list">
                  {recipients.map((r) => (
                    <button
                      key={r}
                      className="share-recipient-btn"
                      disabled={sharing}
                      onClick={() => doShare(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="share-input-row">
              <input
                type="text"
                placeholder="Type a username..."
                value={shareUsername}
                onChange={(e) => setShareUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doShare(shareUsername)}
                disabled={sharing}
              />
              <button
                className="btn btn-coach"
                disabled={sharing || !shareUsername.trim()}
                onClick={() => doShare(shareUsername)}
              >
                {sharing ? 'Sharing...' : 'Share'}
              </button>
            </div>

            {shareMsg && (
              <p style={{
                marginTop: '0.75rem',
                fontSize: '0.85rem',
                color: shareMsg.includes('Failed') || shareMsg.includes('not found') || shareMsg.includes('already') ? 'var(--danger-color)' : 'var(--accent-color)',
              }}>
                {shareMsg}
              </p>
            )}

            <button className="share-modal-close" onClick={() => setShareModal(null)}>&times;</button>
          </div>
        </div>
      )}

      {editModal && (
        <div className="share-modal-overlay" onClick={() => setEditModal(null)}>
          <div
            className="share-modal"
            style={{ maxWidth: 600, maxHeight: '85vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '1.25rem' }}>Edit Match</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {EDIT_FIELDS.map((f) => (
                <div
                  key={f.key}
                  style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : undefined }}
                >
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--muted-text)', marginBottom: '0.3rem' }}>
                    {f.label}
                  </label>
                  {f.type === 'select' ? (
                    <select
                      value={editModal.form[f.key]}
                      onChange={(e) => handleEditField(f.key, e.target.value)}
                      style={{ width: '100%' }}
                    >
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea
                      value={editModal.form[f.key]}
                      onChange={(e) => handleEditField(f.key, e.target.value)}
                      rows={2}
                      style={{ width: '100%', resize: 'vertical' }}
                    />
                  ) : (
                    <input
                      type={f.type}
                      value={editModal.form[f.key]}
                      onChange={(e) => handleEditField(f.key, e.target.value)}
                      style={{ width: '100%' }}
                    />
                  )}
                </div>
              ))}
            </div>

            {editMsg && (
              <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#ef4444' }}>{editMsg}</p>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={editSaving}
                onClick={saveEdit}
              >
                {editSaving ? 'Saving...' : 'Save Changes'}
              </button>
              <button className="btn btn-secondary" onClick={() => setEditModal(null)}>
                Cancel
              </button>
            </div>

            <button className="share-modal-close" onClick={() => setEditModal(null)}>&times;</button>
          </div>
        </div>
      )}

      {deleteModal && (
        <div className="share-modal-overlay" onClick={() => setDeleteModal(null)}>
          <div className="share-modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '0.5rem' }}>Delete Match</h3>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '1.5rem' }}>
              Permanently delete the match vs <strong>{deleteModal['Opp. Name'] || 'Unknown'}</strong> on{' '}
              {formatDate(deleteModal['Match Date'])}? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                className="btn btn-error"
                style={{ flex: 1 }}
                disabled={deleting}
                onClick={confirmDelete}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
              <button className="btn btn-secondary" onClick={() => setDeleteModal(null)}>
                Cancel
              </button>
            </div>
            <button className="share-modal-close" onClick={() => setDeleteModal(null)}>&times;</button>
          </div>
        </div>
      )}
    </div>
  )
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
