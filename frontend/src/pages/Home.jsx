import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'

const CARDS = [
  {
    to: '/log',
    cls: 'card-log',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    ),
    title: 'LOG your Match Details',
    description: 'Reflect on your match or practice session and upload any video to our secure platform.',
    cta: 'Start Logging',
  },
  {
    to: '/track',
    cls: 'card-track',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
    ),
    title: 'TRACK Live Match',
    description: 'Track a live match point-by-point and save detailed stats to your log.',
    cta: 'Start Tracking',
  },
  {
    to: '/video',
    cls: 'card-video',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
    ),
    title: 'ANALYZE your Video',
    description: 'Analyze your match video to get AI insights and detailed performance breakdown.',
    cta: 'Upload Video',
  },
  {
    to: '/stats',
    cls: 'card-stats',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    ),
    title: 'STATS for Progress',
    description: 'View an advanced peformance analytics dashboard with all your match stats and track your progress goals.',
    cta: 'View Stats',
  },
  {
    to: '/crush',
    cls: 'card-crush',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
      </svg>
    ),
    title: 'CRUSH with MatchGenie',
    description: 'Receive opponent analysis, match-winning strategties, actionable insights and training plans to elevate your game.',
    cta: 'Get Insights',
  },
  {
    to: '/coach',
    cls: 'card-coach',
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    ),
    title: 'Coach Connection Hub',
    description: 'Share match stats and view your progress goals with coach guidance, or provide feedback to your players as a coach.',
    cta: 'Open Coach',
  },
]

export default function Home() {
  const { user } = useAuth()
  const [matchCount, setMatchCount] = useState(0)
  const [videoCount, setVideoCount] = useState(0)
  const [promptCount, setPromptCount] = useState(0)
  const [voiceCount, setVoiceCount] = useState(0)
  const [announcements, setAnnouncements] = useState([])

  const raw = user?.first_name || user?.username || 'Player'
  const displayName = raw.charAt(0).toUpperCase() + raw.slice(1)

  useEffect(() => {
    api.get('/matches').then((res) => {
      const m = res.data.matches || []
      setMatchCount(m.length)
      setVideoCount(m.filter((r) => r['Match Video'] && r['Match Video'] !== '').length)
    }).catch(() => {})

    api.get('/stats/usage').then((res) => {
      setPromptCount(res.data.prompt_count || 0)
      setVoiceCount(res.data.voice_count || 0)
    }).catch(() => {})

    api.get('/admin/announcements').then((res) => {
      const items = res.data.announcements || []
      setAnnouncements(items.filter((item) => (
        sessionStorage.getItem(`dismissed_announcement_${user?.id}_${item.id}`) !== 'true'
      )))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (announcements.length === 0) return undefined
    const now = Date.now()
    const nextExpiry = Math.min(...announcements.map((item) => new Date(item.expires_at).getTime()))
    if (nextExpiry <= now) {
      setAnnouncements((prev) => prev.filter((item) => new Date(item.expires_at).getTime() > now))
      return undefined
    }
    const timer = window.setTimeout(() => {
      const currentTime = Date.now()
      setAnnouncements((prev) => prev.filter((item) => new Date(item.expires_at).getTime() > currentTime))
    }, Math.min(nextExpiry - now + 100, 2147483647))
    return () => window.clearTimeout(timer)
  }, [announcements])

  return (
    <div className="home-page">
      {announcements.length > 0 && (
        <section className="home-announcements" aria-label="Announcements">
          {announcements.map((announcement) => (
            <article className="home-announcement" key={announcement.id}>
              <button
                className="home-announcement-dismiss"
                type="button"
                aria-label={`Dismiss ${announcement.title}`}
                title="Dismiss announcement"
                onClick={() => {
                  sessionStorage.setItem(
                    `dismissed_announcement_${user?.id}_${announcement.id}`,
                    'true',
                  )
                  setAnnouncements((prev) => prev.filter((item) => item.id !== announcement.id))
                }}
              >
                ×
              </button>
              <h2>{announcement.title}</h2>
              <p>{announcement.message}</p>
            </article>
          ))}
        </section>
      )}

      {/* Hero */}
      <div className="home-hero">
        <h1 className="home-greeting">Hi, {displayName}!</h1>
        <p className="home-subheading">Where would you like to start?</p>
      </div>

      {/* Usage Stats */}
      <div className="home-stats-bar">
        <div className="home-stat-item">
          <div className="home-stat-value">{matchCount}</div>
          <div className="home-stat-label">Matches Logged</div>
        </div>
        <div className="home-stat-item">
          <div className="home-stat-value">{videoCount}</div>
          <div className="home-stat-label">Videos Uploaded</div>
        </div>
        <div className="home-stat-item">
          <div className="home-stat-value">{promptCount}</div>
          <div className="home-stat-label">Prompts Used</div>
        </div>
        <div className="home-stat-item">
          <div className="home-stat-value">{voiceCount}</div>
          <div className="home-stat-label">Voice Invocations</div>
        </div>
      </div>

      {/* Action Cards */}
      <div className="home-cards-grid">
        {CARDS.map((card, i) => (
          <Link to={card.to} key={card.to} className={`home-action-card ${card.cls}`} style={{ animationDelay: `${(i + 1) * 0.1}s` }}>
            <div className="home-card-icon">{card.icon}</div>
            <h2 className="home-card-title">{card.title}</h2>
            <p className="home-card-desc">{card.description}</p>
            <div className="home-card-arrow">{card.cta} →</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
