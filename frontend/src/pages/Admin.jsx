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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [search, setSearch] = useState('')
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
          <div className="admin-summary-value">{totals.prompts}</div>
          <div className="admin-summary-label">Total Prompts</div>
        </div>
        <div className="admin-summary-card">
          <div className="admin-summary-value">{totals.tokens.toLocaleString()}</div>
          <div className="admin-summary-label">Total Tokens</div>
        </div>
      </div>

      {/* Equity Player Tracker */}
      <div className="admin-equity-section">
        <h2 className="admin-section-title">Equity Player Tracker</h2>
        <div className="admin-summary">
          <div className="admin-summary-card admin-equity-card">
            <div className="admin-summary-value" style={{ color: '#f5c518' }}>{totals.equityPlayers}</div>
            <div className="admin-summary-label">Equity Players</div>
          </div>
          <div className="admin-summary-card admin-equity-card">
            <div className="admin-summary-value" style={{ color: totals.equityPlayers >= 500 ? '#ef4444' : '#22c55e' }}>
              {500 - totals.equityPlayers}
            </div>
            <div className="admin-summary-label">Spots Remaining</div>
          </div>
          <div className="admin-summary-card admin-equity-card">
            <div className="admin-summary-value">{totals.equityPlayers} / 500</div>
            <div className="admin-summary-label">of 500 Target</div>
          </div>
          <div className="admin-summary-card admin-equity-card">
            <div className="admin-summary-value" style={{ color: '#f5c518' }}>
              {((totals.equityPlayers / 500) * 100).toFixed(1)}%
            </div>
            <div className="admin-summary-label">Filled</div>
          </div>
          <div className="admin-summary-card admin-equity-card">
            <div className="admin-summary-value" style={{ color: '#a78bfa' }}>0.02%</div>
            <div className="admin-summary-label">Equity per Spot</div>
          </div>
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
