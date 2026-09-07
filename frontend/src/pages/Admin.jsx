import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'

const TIER_LABELS = { free: 'Free Trial', premium: 'Premium Player', coach: 'Coach' }
const TIER_COLORS = { free: '#6b7280', premium: '#22c55e', coach: '#f59e0b' }

export default function Admin() {
  const { user } = useAuth()
  const [users, setUsers] = useState([])
  const [equityUpdating, setEquityUpdating] = useState({})
  const [archiveUpdating, setArchiveUpdating] = useState({})
  const [limitUpdating, setLimitUpdating] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [search, setSearch] = useState('')
  const [announcements, setAnnouncements] = useState([])
  const [announcementTitle, setAnnouncementTitle] = useState('')
  const [announcementMessage, setAnnouncementMessage] = useState('')
  const [announcementDuration, setAnnouncementDuration] = useState(24)
  const [announcementSaving, setAnnouncementSaving] = useState(false)
  const [announcementError, setAnnouncementError] = useState('')
  const topScrollRef = useRef(null)
  const tableWrapperRef = useRef(null)

  const handleTopScroll = () => {
    if (tableWrapperRef.current) tableWrapperRef.current.scrollLeft = topScrollRef.current.scrollLeft
  }
  const handleBottomScroll = () => {
    if (topScrollRef.current) topScrollRef.current.scrollLeft = tableWrapperRef.current.scrollLeft
  }

  useEffect(() => {
    const syncWidth = () => {
      if (tableWrapperRef.current && topScrollRef.current) {
        const inner = topScrollRef.current.querySelector('.admin-table-scroll-top-inner')
        if (inner) inner.style.width = tableWrapperRef.current.scrollWidth + 'px'
      }
    }
    syncWidth()
    window.addEventListener('resize', syncWidth)
    return () => window.removeEventListener('resize', syncWidth)
  }, [users])

  useEffect(() => {
    api.get('/admin/users')
      .then((res) => setUsers(res.data.users || []))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load users'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    api.get('/admin/announcements/all')
      .then((res) => setAnnouncements(res.data.announcements || []))
      .catch(() => {})
  }, [])

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const filtered = users.filter((u) => {
    const q = search.toLowerCase()
    return (
      u.name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.location?.toLowerCase().includes(q) ||
      u.subscription_tier?.toLowerCase().includes(q)
    )
  })

  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortKey] ?? ''
    let bv = b[sortKey] ?? ''
    if (typeof av === 'number') return sortDir === 'asc' ? av - bv : bv - av
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
  })

  const totals = {
    users: users.length,
    premium: users.filter((u) => u.subscription_tier === 'premium').length,
    coach: users.filter((u) => u.subscription_tier === 'coach').length,
    matches: users.reduce((s, u) => s + (u.match_count || 0), 0),
    videoAnalyses: users.reduce((s, u) => s + (u.video_analysis_count || 0), 0),
    prompts: users.reduce((s, u) => s + u.prompt_count, 0),
    tokens: users.reduce((s, u) => s + u.token_count, 0),
    equityPlayers: users.filter((u) => u.is_equity_player).length,
  }

  const SortArrow = ({ k }) => (
    <span style={{ marginLeft: '0.3rem', opacity: sortKey === k ? 1 : 0.3 }}>
      {sortKey === k && sortDir === 'desc' ? '↓' : '↑'}
    </span>
  )

  if (loading) return <div className="loading">Loading users...</div>
  if (error) return <div className="loading" style={{ color: '#ef4444' }}>{error}</div>

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>Admin Dashboard</h1>
        <p className="admin-subtitle">Logged in as <strong>{user?.username}</strong></p>
      </div>

      <section className="admin-announcements">
        <h2>Announcements</h2>
        <p className="admin-subtitle">Post a message on every user’s Home page for a set number of hours.</p>
        <form
          className="admin-announcement-form"
          onSubmit={async (e) => {
            e.preventDefault()
            setAnnouncementSaving(true)
            setAnnouncementError('')
            try {
              const res = await api.post('/admin/announcements', {
                title: announcementTitle,
                message: announcementMessage,
                duration_hours: Number(announcementDuration),
              })
              setAnnouncements((prev) => [res.data.announcement, ...prev])
              setAnnouncementTitle('')
              setAnnouncementMessage('')
              setAnnouncementDuration(24)
            } catch (err) {
              setAnnouncementError(err.response?.data?.error || 'Could not publish announcement')
            } finally {
              setAnnouncementSaving(false)
            }
          }}
        >
          <input
            type="text"
            maxLength="120"
            placeholder="Announcement title"
            value={announcementTitle}
            onChange={(e) => setAnnouncementTitle(e.target.value)}
            required
          />
          <textarea
            maxLength="2000"
            placeholder="Message shown to every user"
            value={announcementMessage}
            onChange={(e) => setAnnouncementMessage(e.target.value)}
            required
          />
          <label>
            Duration (hours)
            <input
              type="number"
              min="0.25"
              max="8760"
              step="0.25"
              value={announcementDuration}
              onChange={(e) => setAnnouncementDuration(e.target.value)}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={announcementSaving}>
            {announcementSaving ? 'Publishing…' : 'Publish Announcement'}
          </button>
          {announcementError && <div className="admin-announcement-error">{announcementError}</div>}
        </form>

        {announcements.length > 0 && (
          <div className="admin-announcement-list">
            {announcements.map((announcement) => {
              const active = new Date(announcement.expires_at) > new Date()
              return (
                <div className="admin-announcement-row" key={announcement.id}>
                  <div>
                    <strong>{announcement.title}</strong>
                    <span className={active ? 'announcement-active' : 'announcement-expired'}>
                      {active ? 'Active' : 'Expired'}
                    </span>
                    <p>{announcement.message}</p>
                    <small>Expires {new Date(announcement.expires_at).toLocaleString()}</small>
                  </div>
                  <button
                    className="btn btn-outline btn-sm"
                    type="button"
                    onClick={async () => {
                      try {
                        await api.delete(`/admin/announcements/${announcement.id}`)
                        setAnnouncements((prev) => prev.filter((x) => x.id !== announcement.id))
                      } catch (err) {
                        setAnnouncementError(err.response?.data?.error || 'Could not delete announcement')
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Summary Cards */}
      <div className="admin-summary">
        <div className="admin-summary-card">
          <div className="admin-summary-value">{totals.users}</div>
          <div className="admin-summary-label">Total Users</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value" style={{ color: '#22c55e' }}>{totals.premium}</div>
          <div className="admin-summary-label">Premium</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value" style={{ color: '#f59e0b' }}>{totals.coach}</div>
          <div className="admin-summary-label">Coach</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value">{totals.matches}</div>
          <div className="admin-summary-label">Total Matches</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value">{totals.videoAnalyses}</div>
          <div className="admin-summary-label">Video Analyses</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value">{totals.prompts}</div>
          <div className="admin-summary-label">Total Prompts</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value">{totals.tokens.toLocaleString()}</div>
          <div className="admin-summary-label">Total Tokens</div>
        </div>
        <div className="admin-summary-card admin-equity-card">
          <div className="admin-summary-value" style={{ color: '#f5c518' }}>{totals.equityPlayers}</div>
          <div className="admin-summary-label">Equity Players</div>
        </div>
      </div>

      {/* Search */}
      <input
        className="admin-search"
        type="text"
        placeholder="Search by name, email, location, or plan..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Table */}
      <div className="admin-table-scroll-top" ref={topScrollRef} onScroll={handleTopScroll}>
        <div className="admin-table-scroll-top-inner" />
      </div>
      <div className="admin-table-wrapper" ref={tableWrapperRef} onScroll={handleBottomScroll}>
        <table className="admin-table">
          <thead>
            <tr>
              {[
                { key: 'name', label: 'Name' },
                { key: 'email', label: 'Email' },
                { key: 'location', label: 'Location' },
                { key: 'subscription_tier', label: 'Plan' },
                { key: 'match_count', label: 'Matches' },
                { key: 'video_analysis_count', label: 'Videos Analyzed' },
                { key: 'video_analysis_limit', label: 'Video Limit' },
                { key: 'voice_count', label: 'Voice Logs' },
                { key: 'prompt_count', label: 'AI Prompts' },
                { key: 'token_count', label: 'Tokens' },
                { key: 'is_equity_player', label: 'Equity Player' },
                { key: 'last_login', label: 'Last Login' },
                { key: 'is_archived', label: 'Archived' },
              ].map(({ key, label }) => (
                <th key={key} onClick={() => handleSort(key)} className="admin-th">
                  {label}<SortArrow k={key} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => (
              <tr key={u.id} className="admin-tr" style={u.is_archived ? { opacity: 0.45 } : {}}>
                <td className="admin-td admin-td-name">{u.name || '—'}</td>
                <td className="admin-td">{u.email || '—'}</td>
                <td className="admin-td">{u.location || '—'}</td>
                <td className="admin-td">
                  <span className="admin-tier-badge" style={{ color: TIER_COLORS[u.subscription_tier] || '#6b7280', borderColor: TIER_COLORS[u.subscription_tier] || '#6b7280' }}>
                    {TIER_LABELS[u.subscription_tier] || u.subscription_tier}
                  </span>
                </td>
                <td className="admin-td admin-td-num">{u.match_count ?? '—'}</td>
                <td className="admin-td admin-td-num">{u.video_analysis_count ?? 0}</td>
                <td className="admin-td admin-td-num">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={u.video_analysis_limit ?? 3}
                    disabled={limitUpdating[u.id]}
                    aria-label={`Video analysis limit for ${u.name || u.username}`}
                    style={{ width: '5rem' }}
                    onFocus={(e) => {
                      e.target.dataset.savedValue = String(u.video_analysis_limit ?? 3)
                    }}
                    onChange={(e) => {
                      const value = e.target.value
                      setUsers((prev) => prev.map((x) => x.id === u.id
                        ? { ...x, video_analysis_limit: value }
                        : x))
                    }}
                    onBlur={async (e) => {
                      const value = Number.parseInt(e.target.value, 10)
                      if (!Number.isInteger(value) || value < 0) {
                        const savedValue = Number.parseInt(e.target.dataset.savedValue, 10)
                        setUsers((prev) => prev.map((x) => x.id === u.id
                          ? { ...x, video_analysis_limit: Number.isInteger(savedValue) ? savedValue : 3 }
                          : x))
                        return
                      }
                      setLimitUpdating((prev) => ({ ...prev, [u.id]: true }))
                      try {
                        const res = await api.put(`/admin/users/${u.id}/video-analysis-limit`, {
                          video_analysis_limit: value,
                        })
                        setUsers((prev) => prev.map((x) => x.id === u.id
                          ? { ...x, video_analysis_limit: res.data.video_analysis_limit }
                          : x))
                      } catch (err) {
                        console.error('Video analysis limit update failed:', err.response?.data || err)
                        const latest = await api.get('/admin/users')
                        setUsers(latest.data.users || [])
                      } finally {
                        setLimitUpdating((prev) => ({ ...prev, [u.id]: false }))
                      }
                    }}
                  />
                  <small style={{ display: 'block', marginTop: '0.2rem', color: 'var(--muted-text)' }}>
                    {u.video_analysis_limit_used ?? 0} used
                  </small>
                </td>
                <td className="admin-td admin-td-num">{u.voice_count}</td>
                <td className="admin-td admin-td-num">{u.prompt_count}</td>
                <td className="admin-td admin-td-num">{u.token_count.toLocaleString()}</td>
                <td className="admin-td" style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={u.is_equity_player}
                    disabled={equityUpdating[u.id]}
                    onChange={async (e) => {
                      const checked = e.target.checked
                      setEquityUpdating((prev) => ({ ...prev, [u.id]: true }))
                      try {
                        await api.put(`/admin/users/${u.id}/equity`, { is_equity_player: checked })
                        setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, is_equity_player: checked } : x))
                      } catch (err) {
                        console.error('Equity update failed:', err.response?.data || err)
                      } finally {
                        setEquityUpdating((prev) => ({ ...prev, [u.id]: false }))
                      }
                    }}
                  />
                </td>
                <td className="admin-td" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                  {u.last_login ? new Date(u.last_login).toLocaleString() : '—'}
                </td>
                <td className="admin-td" style={{ textAlign: 'center' }}>
                  <button
                    className={`btn btn-sm ${u.is_archived ? 'btn-primary' : 'btn-outline'}`}
                    style={{ fontSize: '0.75rem', opacity: archiveUpdating[u.id] ? 0.5 : 1 }}
                    disabled={archiveUpdating[u.id]}
                    onClick={async () => {
                      setArchiveUpdating((prev) => ({ ...prev, [u.id]: true }))
                      try {
                        await api.put(`/admin/users/${u.id}/archive`, { is_archived: !u.is_archived })
                        setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, is_archived: !u.is_archived } : x))
                      } catch (err) {
                        console.error('Archive update failed:', err.response?.data || err)
                      } finally {
                        setArchiveUpdating((prev) => ({ ...prev, [u.id]: false }))
                      }
                    }}
                  >
                    {u.is_archived ? 'Unarchive' : 'Archive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--muted-text)', padding: '2rem' }}>No users found.</p>
        )}
      </div>
    </div>
  )
}
