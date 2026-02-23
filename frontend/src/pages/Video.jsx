import { useState, useEffect } from 'react'
import api from '../api/client'

const MOCK_MATCHES = [
  { opponent: 'John Smith', date: '2024-01-15', result: 'W', score: '6-4, 7-5' },
  { opponent: 'Michael Johnson', date: '2024-01-08', result: 'L', score: '4-6, 6-7' },
  { opponent: 'David Williams', date: '2023-12-22', result: 'W', score: '6-3, 6-2' },
  { opponent: 'Chris Anderson', date: '2023-12-15', result: 'W', score: '7-6, 3-6, 6-4' },
  { opponent: 'Robert Martinez', date: '2023-12-01', result: 'L', score: '2-6, 4-6' },
]

export default function Video() {
  const [matches, setMatches] = useState([])
  const [expandedMatch, setExpandedMatch] = useState(null)
  const [selectedTab, setSelectedTab] = useState('Match Summary')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/video/matches')
      .then((res) => setMatches(res.data.matches || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const displayMatches = matches.length > 0 ? matches : MOCK_MATCHES

  return (
    <div className="video-page">
      <h1>Match Video Library</h1>

      <div className="coming-soon-banner">
        <strong>Coming soon.</strong> This is just a preview.
      </div>

      {loading ? <p>Loading...</p> : (
        <div className="match-list">
          {displayMatches.map((match, i) => {
            const isExpanded = expandedMatch === i
            return (
              <div key={i} className="match-expander">
                <button
                  className="match-expander-header"
                  onClick={() => setExpandedMatch(isExpanded ? null : i)}
                >
                  <div className="match-expander-info">
                    <span className={`badge ${match.result === 'W' ? 'badge-win' : 'badge-loss'}`}>
                      {match.result === 'W' ? 'Won' : 'Lost'}
                    </span>
                    <span className="match-opp">vs {match.opponent}</span>
                    <span className="match-date">{match.date}</span>
                    <span className="match-score">{match.score}</span>
                  </div>
                  <span className="expander-arrow">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                </button>

                {isExpanded && (
                  <div className="match-expander-body">
                    <h3>Video Analysis</h3>

                    <div className="analysis-layout">
                      <div className="analysis-nav">
                        {['Match Summary', 'Service Analysis', 'Groundstroke Analysis', 'Return Analysis'].map((tab) => (
                          <button key={tab}
                            className={`analysis-nav-btn ${selectedTab === tab ? 'active' : ''}`}
                            onClick={() => setSelectedTab(tab)}
                          >{tab}</button>
                        ))}
                      </div>

                      <div className="analysis-content">
                        {selectedTab === 'Match Summary' && (
                          <div>
                            <h4>Match Summary</h4>
                            <div className="comparison-stats">
                              {[['Points Won', 44, 44], ['Errors', 25, 20], ['Winners', 8, 7], ['Aces', 2, 3], ['Double Faults', 4, 3]].map(([label, you, opp]) => (
                                <div key={label} className="comparison-row">
                                  <span className="comp-value comp-you">{you}</span>
                                  <span className="comp-label">{label}</span>
                                  <span className="comp-value comp-opp">{opp}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {selectedTab === 'Service Analysis' && (
                          <div>
                            <h4>Service Stats</h4>
                            <div className="stat-card-grid">
                              {[['1st Serve %', '50%'], ['1st Serve Won', '59%'], ['2nd Serve Won', '41%'], ['Aces', '3'], ['Double Faults', '4']].map(([label, val]) => (
                                <div key={label} className="stat-card">
                                  <div className="stat-card-label">{label}</div>
                                  <div className="stat-card-value">{val}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {selectedTab === 'Groundstroke Analysis' && (
                          <div>
                            <h4>Groundstroke Stats</h4>
                            <div className="stat-card-grid">
                              {[['Forehands', '29'], ['FH Errors', '24'], ['FH Winners', '5'], ['Backhands', '19'], ['BH Errors', '16'], ['BH Winners', '3']].map(([label, val]) => (
                                <div key={label} className="stat-card">
                                  <div className="stat-card-label">{label}</div>
                                  <div className="stat-card-value">{val}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {selectedTab === 'Return Analysis' && (
                          <div>
                            <h4>Return Stats</h4>
                            <div className="stat-card-grid">
                              {[['FH Returns Won', '52%'], ['Returns In', '21'], ['Return Errors', '4'], ['Returns Made', '84%']].map(([label, val]) => (
                                <div key={label} className="stat-card">
                                  <div className="stat-card-label">{label}</div>
                                  <div className="stat-card-value">{val}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Coming Soon Video Placeholder */}
                    <div className="video-placeholder">
                      <div className="video-play-button">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                      </div>
                      <p>Analyzed Match Video</p>
                      <span className="coming-soon-badge">Coming Soon</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
