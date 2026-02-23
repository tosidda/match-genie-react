import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'
import logo from '../assets/matchgenie.png'

const PROMPTS = [
  'How do I beat an opponent?',
  'Generate training plan',
  'Analyze video from my match',
  'Prepare for my next tournament',
  'Team lineup and strategies',
]

const SIDEBAR_PROMPTS = [
  'Training plan',
  'Analyze my video',
  'Tournament prep',
  'Team lineup',
]

export default function Crush() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [matchCount, setMatchCount] = useState(0)
  const [teamCount, setTeamCount] = useState(0)
  const [promptCount, setPromptCount] = useState(0)
  const [opponents, setOpponents] = useState([])
  const messagesEndRef = useRef(null)
  const matchContextHandled = useRef(false)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load user data for sidebar
  useEffect(() => {
    api.get('/matches').then((res) => {
      const m = res.data.matches || []
      setMatchCount(m.length)
      const names = [...new Set(m.map((r) => r['Opp. Name']).filter(Boolean))]
      setOpponents(names)
    }).catch(() => {})

    api.get('/stats/shared').then((res) => {
      setTeamCount((res.data.sharer_usernames || []).length)
    }).catch(() => {})

    api.get('/stats/usage').then((res) => {
      setPromptCount(res.data.prompt_count || 0)
    }).catch(() => {})
  }, [])

  // Auto-send match analysis prompt from Matches page
  useEffect(() => {
    if (location.state?.matchContext && !matchContextHandled.current) {
      matchContextHandled.current = true
      const prompt = location.state.matchContext
      navigate('/crush', { replace: true })
      // Small delay to ensure state is cleared before sending
      setTimeout(() => sendMessage(prompt), 100)
    }
  }, [location.state])

  const sendMessage = async (text) => {
    if (!text.trim() || streaming) return

    const isTeam = text === 'Team lineup and strategies' || text === 'Team lineup'
    const userMsg = { role: 'user', content: isTeam ? 'Help me create a team lineup and winning strategies for my tennis team.' : text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setStreaming(true)
    setPromptCount((c) => c + 1)

    setMessages([...newMessages, { role: 'assistant', content: '' }])

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/crush/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
          prompt: text,
          is_team_lineup: isTeam,
        }),
      })

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n').filter((l) => l.startsWith('data: '))

        for (const line of lines) {
          const data = line.slice(6)
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            assistantContent += parsed.content
            setMessages([...newMessages, { role: 'assistant', content: assistantContent }])
          } catch {
            // skip parse errors
          }
        }
      }

      setMessages([...newMessages, { role: 'assistant', content: assistantContent }])

      // Save training plan if this was a training plan prompt
      if (text.toLowerCase().includes('training plan') && assistantContent) {
        api.put('/stats/training-plan', { training_plan: assistantContent }).catch(() => {})
      }
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: 'Sorry, I encountered an error.' }])
    } finally {
      setStreaming(false)
    }
  }

  const newConversation = () => {
    setMessages([])
  }

  const raw = user?.first_name || user?.username || 'Player'
  const displayName = raw.charAt(0).toUpperCase() + raw.slice(1)

  return (
    <div className="crush-layout">
      {/* Main Chat Area */}
      <div className="crush-main">
        {/* Header with logo and greeting (shown when no messages) */}
        {messages.length === 0 && (
          <div className="crush-hero">
            <div className="crush-logo">
              <img src={logo} alt="Match Genie" />
            </div>
            <h1>Hey {displayName}, what can I help you with?</h1>
            <p className="crush-subtitle">Your AI coach with access to {matchCount} of your logged matches</p>
          </div>
        )}

        {/* Prompt Buttons (shown when no messages) */}
        {messages.length === 0 && (
          <div className="crush-prompts">
            <div className="crush-prompts-row">
              {PROMPTS.slice(0, 3).map((p) => (
                <button key={p} className="crush-prompt-btn" onClick={() => sendMessage(p)} disabled={streaming}>
                  {p}
                </button>
              ))}
            </div>
            <div className="crush-prompts-row">
              {PROMPTS.slice(3).map((p) => (
                <button key={p} className="crush-prompt-btn" onClick={() => sendMessage(p)} disabled={streaming}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Chat Messages */}
        <div className="crush-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`crush-msg ${msg.role}`}>
              <div className={`crush-msg-icon ${msg.role}`}>
                {msg.role === 'user' ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z"/></svg>
                )}
              </div>
              <div className="crush-msg-content">
                {msg.role === 'assistant' ? (
                  <div dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.content) }} />
                ) : (
                  <p>{msg.content}</p>
                )}
                {msg.role === 'assistant' && streaming && i === messages.length - 1 && (
                  <span className="cursor-blink">|</span>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <form className="crush-input-bar" onSubmit={(e) => { e.preventDefault(); sendMessage(input) }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask your coach anything..."
            disabled={streaming}
          />
          <button type="submit" className="crush-send-btn" disabled={streaming || !input.trim()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </form>
      </div>

      {/* Right Sidebar */}
      <div className="crush-sidebar">
        <button className="crush-new-convo" onClick={newConversation}>
          New Conversation
        </button>

        <hr />

        {/* Your Data */}
        <div className="crush-sidebar-section">
          <div className="crush-sidebar-title">YOUR DATA</div>
          <div className="crush-data-row">
            <span>Matches logged</span>
            <span className="crush-data-value">{matchCount}</span>
          </div>
          <div className="crush-data-row">
            <span>Team members</span>
            <span className="crush-data-value">{teamCount}</span>
          </div>
          <div className="crush-data-row">
            <span>Prompts used</span>
            <span className="crush-data-value">{promptCount}</span>
          </div>
        </div>

        <hr />

        {/* Quick: Beat an Opponent */}
        {opponents.length > 0 && (
          <>
            <div className="crush-sidebar-section">
              <div className="crush-sidebar-title">QUICK: BEAT AN OPPONENT</div>
              {opponents.slice(0, 5).map((name) => (
                <button key={name} className="crush-opp-btn"
                  onClick={() => sendMessage(`How do I beat ${name}?`)} disabled={streaming}>
                  {name}
                </button>
              ))}
            </div>
            <hr />
          </>
        )}

        {/* Suggested Prompts */}
        <div className="crush-sidebar-section">
          <div className="crush-sidebar-title">SUGGESTED PROMPTS</div>
          {SIDEBAR_PROMPTS.map((p) => (
            <button key={p} className="crush-suggest-btn"
              onClick={() => sendMessage(p)} disabled={streaming}>
              {p}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function formatMarkdown(text) {
  if (!text) return ''

  // First, extract and convert markdown tables before other processing
  // A table is a block of consecutive lines that contain pipes
  const lines = text.split('\n')
  const processed = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Detect start of a markdown table (line with pipes)
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i])
        i++
      }

      if (tableLines.length >= 2) {
        let html = '<table class="md-table">'

        // Header row
        const headerCells = tableLines[0].split('|').filter(Boolean).map((c) => c.trim())
        html += '<thead><tr>' + headerCells.map((c) => `<th>${applyInline(c)}</th>`).join('') + '</tr></thead>'

        // Skip separator row (row with dashes like |---|---|---|)
        const startRow = tableLines[1].trim().match(/^\|[\s\-:]+\|/) ? 2 : 1

        // Body rows
        html += '<tbody>'
        for (let r = startRow; r < tableLines.length; r++) {
          const cells = tableLines[r].split('|').filter(Boolean).map((c) => c.trim())
          html += '<tr>' + cells.map((c) => `<td>${applyInline(c)}</td>`).join('') + '</tr>'
        }
        html += '</tbody></table>'
        processed.push(html)
      } else {
        // Not enough lines for a table, treat as normal
        processed.push(...tableLines)
      }
    } else {
      processed.push(line)
      i++
    }
  }

  // Now process non-table lines
  return processed.map((line) => {
    // Skip lines that are already HTML tables
    if (line.startsWith('<table')) return line

    line = applyInline(line)

    // Headers
    if (line.match(/^### /)) return `<h3>${line.slice(4)}</h3>`
    if (line.match(/^## /)) return `<h2>${line.slice(3)}</h2>`
    if (line.match(/^# /)) return `<h1>${line.slice(2)}</h1>`

    // List items
    if (line.match(/^- /)) return `<li>${line.slice(2)}</li>`
    if (line.match(/^\d+\.\s/)) return `<li>${line.replace(/^\d+\.\s/, '')}</li>`

    // Empty line = paragraph break
    if (line.trim() === '') return '<br />'

    return `<p>${line}</p>`
  }).join('')
}

function applyInline(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
}
