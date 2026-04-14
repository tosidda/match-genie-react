import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'

const SERVE_PLACEMENTS = ['Wide', 'Down the T', 'Body', 'Random/Varied']
const RETURN_PLACEMENTS = ['Crosscourt', 'Down the Line', 'Middle', 'Random/Varied']
const PLAYING_STYLES = [
  'Aggressive Baseline', 'Counterpuncher', 'Serve and Volley',
  'All-Court Player', 'Defensive Player', 'Lefty',
  'One-Handed Backhand', 'Net Player', 'Grinder', 'Wall',
]
const OPPONENT_RANKINGS = ['1-100', '100-300', '300-500', 'Below 500']
const UPLOAD_STATS_OPTIONS = ['SwingVision', 'TennisTracker']
const STEP_LABELS = ['Match Basics', 'Opponent', 'Media', 'Stats', 'Review']

const INITIAL_DATA = () => ({
  matchDate: new Date().toISOString().split('T')[0],
  surfaceType: 'Hard',
  result: 'W',
  playerSet1: 0, playerSet2: 0, playerSet3: 0,
  oppSet1: 0, oppSet2: 0, oppSet3: 0,
  opponentName: '',
  utrRating: 1.0,
  oppRanking: '1-100',
  oppPlayingStyle: [],
  uploadedVideo: null,
  ytUrl: '',
  uploadStatsOption: 'SwingVision',
  uploadedFile: null,
  firstServePct: 50,
  firstServePctWon: 50,
  secondServePct: 50,
  aces: 0,
  doubleFaults: 0,
  serveSpeed: 90,
  servePlacement: [],
  returnPct: 50,
  returnPlacement: [],
  winners: 0,
  unforcedErrors: 0,
  forcedErrors: 0,
  avgRallyLength: 0,
  netPointsWon: 0,
  breakPointsWon: 0,
  breakPointsSaved: 0,
  mentalGame: '',
  matchDescription: '',
})

export default function Log() {
  const { user } = useAuth()
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [step, setStep] = useState(1)
  const [statsSubstep, setStatsSubstep] = useState(1)
  const [d, setD] = useState(INITIAL_DATA())
  const [previousOpponents, setPreviousOpponents] = useState([])
  const [showOppSuggestions, setShowOppSuggestions] = useState(false)

  // Voice mode state
  const [voiceMode, setVoiceMode] = useState(false)
  const [voiceMessages, setVoiceMessages] = useState([])
  const [voiceInput, setVoiceInput] = useState('')
  const [voiceStreaming, setVoiceStreaming] = useState(false)
  const [extractedData, setExtractedData] = useState(null)
  const [voiceReview, setVoiceReview] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [micBlocked, setMicBlocked] = useState(false)
  const voiceEndRef = useRef(null)
  const recognitionRef = useRef(null)
  const audioRef = useRef(null)
  const autoRestartRef = useRef(false)
  const audioContextRef = useRef(null)   // unlocked AudioContext for iOS TTS
  const liveTranscriptRef = useRef('')   // avoids stale closure when stopping

  useEffect(() => {
    api.get('/matches').then((res) => {
      const m = res.data.matches || []
      setMatches(m)
      const names = [...new Set(m.map((r) => r['Opp. Name']).filter(Boolean))].sort()
      setPreviousOpponents(names)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    voiceEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [voiceMessages])

  const [validationError, setValidationError] = useState('')
  const update = (key, value) => setD((prev) => ({ ...prev, [key]: value }))
  const updateNum = (key, value) => setD((prev) => ({ ...prev, [key]: value === '' ? '' : parseInt(value) }))

  const toggleMulti = (key, value) => {
    setD((prev) => {
      const list = prev[key]
      return { ...prev, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] }
    })
  }

  // --- Unlock AudioContext on first user gesture (required by iOS/Chrome) ---
  const unlockAudio = async () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioCtx()
      }
      const ctx = audioContextRef.current
      // Must resume() — Chrome iOS starts contexts in suspended state
      if (ctx.state === 'suspended') await ctx.resume()
      // Play silent buffer to fully satisfy autoplay policy
      const buf = ctx.createBuffer(1, 1, 22050)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.start(0)
    } catch { /* ignore */ }
  }

  // --- TTS: Speak text aloud using OpenAI TTS ---
  const speakText = async (text) => {
    setSpeaking(true)
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/voice-log/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) { setSpeaking(false); return }

      const arrayBuffer = await response.arrayBuffer()
      const ctx = audioContextRef.current
      let played = false

      // Try AudioContext path first (works on iOS Safari + Chrome iOS after unlock)
      if (ctx && ctx.state !== 'closed') {
        try {
          if (ctx.state === 'suspended') await ctx.resume()
          const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
          await new Promise((resolve) => {
            const source = ctx.createBufferSource()
            source.buffer = decoded
            source.connect(ctx.destination)
            source.onended = resolve
            source.start(0)
            audioRef.current = source
          })
          played = true
        } catch { /* fall through to Audio element */ }
      }

      // Fallback: HTMLAudioElement (desktop, and any mobile that blocked AudioContext)
      if (!played) {
        const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audioRef.current = audio
        await new Promise((resolve) => {
          audio.onended = () => { URL.revokeObjectURL(url); resolve() }
          audio.onerror = () => { URL.revokeObjectURL(url); resolve() }
          audio.play().catch(resolve)
        })
      }
    } catch {
      // TTS failed silently — text is still shown on screen
    } finally {
      setSpeaking(false)
    }
  }

  // --- STT: Listen for user speech ---
  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setMessage('Speech recognition is not supported in this browser.')
      return
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

    // On iOS, only Safari supports Web Speech API — Chrome (CriOS or desktop UA),
    // Firefox (FxiOS), and other browsers fail silently without a mic permission prompt.
    const isNonSafariIOS = isIOS && (/CriOS|FxiOS|OPiOS/.test(navigator.userAgent) ||
      (!!window.chrome) ||
      (/Chrome/.test(navigator.userAgent) && !/Safari/.test(navigator.userAgent)))
    if (isNonSafariIOS) {
      setMicBlocked(true)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = !isIOS   // iOS silently ignores continuous=true
    recognition.interimResults = !isIOS  // interim results cause issues on iOS
    recognition.lang = 'en-US'
    recognitionRef.current = recognition
    autoRestartRef.current = true
    liveTranscriptRef.current = ''

    let finalTranscript = ''

    recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' '
        } else {
          interim += event.results[i][0].transcript
        }
      }
      const combined = finalTranscript + interim
      liveTranscriptRef.current = combined
      setLiveTranscript(combined)
    }

    recognition.onerror = (event) => {
      if (event.error === 'aborted') return  // expected when we call .stop()
      if (event.error === 'no-speech') {
        if (autoRestartRef.current) {
          try { recognition.start() } catch { }
        }
        return
      }
      // Any error other than no-speech/aborted means mic isn't usable in this browser.
      // 'network' is the typical error on Chrome iOS (Google STT unreachable via WebKit).
      setMicBlocked(true)
      autoRestartRef.current = false
      setListening(false)
    }

    recognition.onend = () => {
      // iOS ends after every utterance — restart to keep listening
      if (autoRestartRef.current) {
        try { recognition.start() } catch { }
      } else {
        setListening(false)
      }
    }

    liveTranscriptRef.current = ''
    setLiveTranscript('')
    setListening(true)
    recognition.start()
  }

  const stopListeningAndSend = () => {
    autoRestartRef.current = false
    // Grab transcript from ref before anything async can clear it
    const transcript = liveTranscriptRef.current
    liveTranscriptRef.current = ''
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setListening(false)
    setLiveTranscript('')
    if (transcript.trim()) {
      sendVoiceMessage(transcript.trim())
    }
  }

  // --- Voice Mode Functions ---
  const activateVoiceMode = async () => {
    await unlockAudio()  // must happen in the user gesture context and be awaited
    const rawName = user?.first_name || user?.username || ''
    const displayName = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : ''
    const greeting = `Hey${displayName ? ' ' + displayName : ''}! Let's log your match. Tell me about the basics. When did you play, what surface, and did you win or lose? What was the score?`
    setVoiceMode(true)
    setVoiceMessages([{ role: 'assistant', content: greeting }])
    setVoiceInput('')
    setExtractedData(null)
    setVoiceReview(false)
    // Speak the greeting
    await speakText(greeting)
  }

  const exitVoiceMode = () => {
    autoRestartRef.current = false
    if (audioRef.current) {
      try { audioRef.current.stop?.(); audioRef.current.pause?.() } catch {}
      audioRef.current = null
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close() } catch {}
      audioContextRef.current = null
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    if (voiceMessages.length > 1 && !confirm('Exit voice mode? Your conversation will be lost.')) return
    setVoiceMode(false)
    setVoiceMessages([])
    setVoiceInput('')
    setVoiceStreaming(false)
    setExtractedData(null)
    setVoiceReview(false)
    setExtracting(false)
    setListening(false)
    setSpeaking(false)
    setLiveTranscript('')
    setMicBlocked(false)
  }

  const sendVoiceMessage = async (text) => {
    if (!text.trim() || voiceStreaming) return

    const userMsg = { role: 'user', content: text }
    const newMessages = [...voiceMessages, userMsg]
    setVoiceMessages(newMessages)
    setVoiceInput('')
    setVoiceStreaming(true)

    setVoiceMessages([...newMessages, { role: 'assistant', content: '' }])

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/voice-log/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
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
            setVoiceMessages([...newMessages, { role: 'assistant', content: assistantContent }])
          } catch {
            // skip parse errors
          }
        }
      }

      setVoiceMessages([...newMessages, { role: 'assistant', content: assistantContent }])
      setVoiceStreaming(false)

      // Speak the AI response aloud
      if (assistantContent) {
        await speakText(assistantContent)
      }
    } catch {
      setVoiceMessages([...newMessages, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
      setVoiceStreaming(false)
    }
  }

  const extractAndReview = async () => {
    setExtracting(true)
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/voice-log/extract', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: voiceMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      })
      const data = await response.json()
      if (data.error) {
        setMessage('Failed to extract match data: ' + data.error)
        return
      }
      setExtractedData(data)
      setVoiceReview(true)
      // Track voice invocation only when user reaches review
      api.put('/stats/voice-count').catch(() => {})
    } catch {
      setMessage('Failed to extract match data. Please try again.')
    } finally {
      setExtracting(false)
    }
  }

  const submitFromVoice = async () => {
    if (!extractedData) return
    setSubmitting(true)
    setMessage('')

    const ed = extractedData
    const matchScore = `${ed.playerSet1 || 0}-${ed.oppSet1 || 0}, ${ed.playerSet2 || 0}-${ed.oppSet2 || 0}, ${ed.playerSet3 || 0}-${ed.oppSet3 || 0}`

    const formData = new FormData()
    formData.append('match_date', ed.matchDate || new Date().toISOString().split('T')[0])
    formData.append('surface_type', ed.surfaceType || 'Hard')
    formData.append('result', ed.result || 'W')
    formData.append('match_score', matchScore)
    formData.append('opponent_name', ed.opponentName || '')
    formData.append('opponent_ranking', ed.oppRanking || '1-100')
    formData.append('opponent_playing_style', (ed.oppPlayingStyle || []).join(', '))
    formData.append('match_description', ed.matchDescription || '')
    formData.append('youtube_url', '')
    formData.append('utr', ed.utrRating || 'UR')
    formData.append('first_serve_percentage', ed.firstServePct || 0)
    formData.append('first_serve_percentage_won', ed.firstServePctWon || 0)
    formData.append('second_serve_percentage', ed.secondServePct || 0)
    formData.append('aces', ed.aces || 0)
    formData.append('double_faults', ed.doubleFaults || 0)
    formData.append('serve_speed', ed.serveSpeed || 0)
    formData.append('serve_placement', (ed.servePlacement || []).join(', '))
    formData.append('return_percentage', ed.returnPct || 0)
    formData.append('return_placement', (ed.returnPlacement || []).join(', '))
    formData.append('winners', ed.winners || 0)
    formData.append('unforced_errors', ed.unforcedErrors || 0)
    formData.append('forced_errors', ed.forcedErrors || 0)
    formData.append('average_rally_length', ed.avgRallyLength || 0)
    formData.append('net_points_won', ed.netPointsWon || 0)
    formData.append('break_points_won', ed.breakPointsWon || 0)
    formData.append('break_points_saved', ed.breakPointsSaved || 0)
    formData.append('mental_game', ed.mentalGame || '')

    try {
      const res = await api.post('/matches', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setMessage(res.data.message || 'Match logged successfully!')
      const refreshed = await api.get('/matches')
      setMatches(refreshed.data.matches || [])
      setVoiceMode(false)
      setVoiceMessages([])
      setVoiceInput('')
      setExtractedData(null)
      setVoiceReview(false)
    } catch (err) {
      setMessage(err.response?.data?.error || 'Failed to log match')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setMessage('')

    const matchScore = `${d.playerSet1}-${d.oppSet1}, ${d.playerSet2}-${d.oppSet2}, ${d.playerSet3}-${d.oppSet3}`

    const formData = new FormData()
    formData.append('match_date', d.matchDate)
    formData.append('surface_type', d.surfaceType)
    formData.append('result', d.result)
    formData.append('match_score', matchScore)
    formData.append('opponent_name', d.opponentName)
    formData.append('opponent_ranking', d.oppRanking)
    formData.append('opponent_playing_style', d.oppPlayingStyle.join(', '))
    formData.append('match_description', d.matchDescription)
    formData.append('youtube_url', d.ytUrl)
    formData.append('utr', d.utrRating || 'UR')
    formData.append('first_serve_percentage', d.firstServePct)
    formData.append('first_serve_percentage_won', d.firstServePctWon)
    formData.append('second_serve_percentage', d.secondServePct)
    formData.append('aces', d.aces)
    formData.append('double_faults', d.doubleFaults)
    formData.append('serve_speed', d.serveSpeed)
    formData.append('serve_placement', d.servePlacement.join(', '))
    formData.append('return_percentage', d.returnPct)
    formData.append('return_placement', d.returnPlacement.join(', '))
    formData.append('winners', d.winners)
    formData.append('unforced_errors', d.unforcedErrors)
    formData.append('forced_errors', d.forcedErrors)
    formData.append('average_rally_length', d.avgRallyLength)
    formData.append('net_points_won', d.netPointsWon)
    formData.append('break_points_won', d.breakPointsWon)
    formData.append('break_points_saved', d.breakPointsSaved)
    formData.append('mental_game', d.mentalGame)
    if (d.uploadedVideo) formData.append('video', d.uploadedVideo)
    if (d.uploadedFile) formData.append('stats_file', d.uploadedFile)

    try {
      const res = await api.post('/matches', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setMessage(res.data.message || 'Match logged successfully!')
      const refreshed = await api.get('/matches')
      setMatches(refreshed.data.matches || [])
      setD(INITIAL_DATA())
      setStep(1)
      setStatsSubstep(1)
    } catch (err) {
      setMessage(err.response?.data?.error || 'Failed to log match')
    } finally {
      setSubmitting(false)
    }
  }

  // --- Progress Stepper ---
  const ProgressStepper = () => (
    <div className="wizard-progress">
      {STEP_LABELS.map((label, i) => {
        const num = i + 1
        const status = num < step ? 'completed' : num === step ? 'active' : 'pending'
        return (
          <div key={label} className="wizard-step-wrapper">
            <div className="wizard-step">
              <div className={`wizard-step-circle ${status}`}>
                {num < step ? '\u2713' : num}
              </div>
              <div className={`wizard-step-label ${status}`}>{label}</div>
            </div>
            {num < STEP_LABELS.length && (
              <div className={`wizard-connector ${num < step ? 'completed' : ''}`} />
            )}
          </div>
        )
      })}
    </div>
  )

  // --- Step 1: Match Basics ---
  const Step1 = () => (
    <div className="step-container">
      <div className="step-title">Match Basics</div>
      <div className="form-row">
        <div className="form-group">
          <label>Match Date</label>
          <input type="date" value={d.matchDate} onChange={(e) => update('matchDate', e.target.value)} />
        </div>
        <div className="form-group">
          <label>Surface Type</label>
          <select value={d.surfaceType} onChange={(e) => update('surfaceType', e.target.value)}>
            <option>Hard</option><option>Clay</option><option>Grass</option>
          </select>
        </div>
        <div className="form-group">
          <label>Result</label>
          <select value={d.result} onChange={(e) => update('result', e.target.value)}>
            <option>W</option><option>L</option>
          </select>
        </div>
      </div>

      <div className="score-grid">
        <h4>Score <span style={{ color: '#ef4444' }}>*</span></h4>
        <div className="score-header">
          <span></span><span>SET 1</span><span>SET 2</span><span>SET 3</span>
        </div>
        <div className="score-row">
          <span>You</span>
          {['playerSet1', 'playerSet2', 'playerSet3'].map((key) => (
            <input key={key} type="number" min="0" max="7"
              value={d[key]}
              onChange={(e) => updateNum(key, e.target.value)} />
          ))}
        </div>
        <div className="score-row">
          <span>Opponent</span>
          {['oppSet1', 'oppSet2', 'oppSet3'].map((key) => (
            <input key={key} type="number" min="0" max="7"
              value={d[key]}
              onChange={(e) => updateNum(key, e.target.value)} />
          ))}
        </div>
      </div>
    </div>
  )

  // --- Step 2: Opponent Info ---
  const Step2 = () => (
    <div className="step-container">
      <div className="step-title">Opponent Information</div>
      <div className="form-row">
        <div className="form-group" style={{ flex: 1 }}>
          <label>Opponent Name <span style={{ color: '#ef4444' }}>*</span></label>
          <div className="autocomplete-wrapper">
            <input type="text" value={d.opponentName}
              onChange={(e) => { update('opponentName', e.target.value); setShowOppSuggestions(true) }}
              onFocus={() => setShowOppSuggestions(true)}
              onBlur={() => setTimeout(() => setShowOppSuggestions(false), 150)}
              placeholder="Enter opponent name"
              autoComplete="off" />
            {showOppSuggestions && d.opponentName && previousOpponents.filter((name) =>
              name.toLowerCase().includes(d.opponentName.toLowerCase()) && name.toLowerCase() !== d.opponentName.toLowerCase()
            ).length > 0 && (
              <ul className="autocomplete-list">
                {previousOpponents.filter((name) =>
                  name.toLowerCase().includes(d.opponentName.toLowerCase()) && name.toLowerCase() !== d.opponentName.toLowerCase()
                ).map((name) => (
                  <li key={name} onMouseDown={() => { update('opponentName', name); setShowOppSuggestions(false) }}>
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="form-group">
          <label>UTR Rating</label>
          <input type="number" min="1" max="17" step="0.25"
            value={d.utrRating}
            onChange={(e) => update('utrRating', e.target.value === '' ? '' : (parseFloat(e.target.value) || 0))} />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Ranking Bracket</label>
          <select value={d.oppRanking} onChange={(e) => update('oppRanking', e.target.value)}>
            {OPPONENT_RANKINGS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label>Playing Style <span style={{ color: '#ef4444' }}>*</span></label>
        <div className="chip-group">
          {PLAYING_STYLES.map((s) => (
            <button type="button" key={s}
              className={`chip ${d.oppPlayingStyle.includes(s) ? 'chip-active' : ''}`}
              onClick={() => toggleMulti('oppPlayingStyle', s)}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  )

  // --- Step 3: Media & Import ---
  const Step3 = () => (
    <div className="step-container">
      <div className="step-title">Media & Stats Import</div>
      <div className="form-row">
        <div className="form-section" style={{ flex: 1 }}>
          <h4>Match Video</h4>
          <div className="form-group">
            <label>Upload Video</label>
            <input type="file" accept="video/mp4,video/mov,video/avi"
              onChange={(e) => update('uploadedVideo', e.target.files[0] || null)} />
          </div>
          <div className="form-group">
            <label>Or paste YouTube Link</label>
            <textarea rows="3" value={d.ytUrl}
              onChange={(e) => update('ytUrl', e.target.value)}
              placeholder="https://youtube.com/..." />
          </div>
        </div>

        <div className="form-section" style={{ flex: 1 }}>
          <h4>Import Stats from App</h4>
          <div className="form-group">
            <label>Select App</label>
            <select value={d.uploadStatsOption}
              onChange={(e) => update('uploadStatsOption', e.target.value)}>
              {UPLOAD_STATS_OPTIONS.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Upload CSV/XLSX</label>
            <input type="file" accept=".csv,.xlsx"
              onChange={(e) => update('uploadedFile', e.target.files[0] || null)} />
          </div>
          <div className="alert alert-info">
            Stats will be auto-extracted and can be adjusted in the next step.
          </div>
        </div>
      </div>
    </div>
  )

  // --- Step 4: Performance Stats (with sub-wizard) ---
  const StatsSubTabs = () => {
    const labels = ['Serve & Return Stats', 'Shot Stats']
    return (
      <div className="sub-wizard-tabs">
        {labels.map((label, i) => {
          const num = i + 1
          const cls = num < statsSubstep ? 'completed' : num === statsSubstep ? 'active' : ''
          return (
            <div key={label} className={`sub-wizard-tab ${cls}`}>{label}</div>
          )
        })}
      </div>
    )
  }

  const ServeReturnStats = () => (
    <div className="form-row">
      <div className="form-section" style={{ flex: 1 }}>
        <h4>Serve Stats</h4>
        <div className="form-group">
          <label>First Serve % ({d.firstServePct}%)</label>
          <input type="range" min="0" max="100" value={d.firstServePct}
            onChange={(e) => update('firstServePct', parseInt(e.target.value))} />
        </div>
        <div className="form-group">
          <label>First Serve Won % ({d.firstServePctWon}%)</label>
          <input type="range" min="0" max="100" value={d.firstServePctWon}
            onChange={(e) => update('firstServePctWon', parseInt(e.target.value))} />
        </div>
        <div className="form-group">
          <label>Second Serve % ({d.secondServePct}%)</label>
          <input type="range" min="0" max="100" value={d.secondServePct}
            onChange={(e) => update('secondServePct', parseInt(e.target.value))} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Aces</label>
            <input type="number" min="0" value={d.aces}
              onChange={(e) => update('aces', e.target.value === '' ? '' : parseInt(e.target.value))} />
          </div>
          <div className="form-group">
            <label>Double Faults</label>
            <input type="number" min="0" value={d.doubleFaults}
              onChange={(e) => update('doubleFaults', e.target.value === '' ? '' : parseInt(e.target.value))} />
          </div>
        </div>
        <div className="form-group">
          <label>Serve Speed ({d.serveSpeed} MPH)</label>
          <input type="range" min="60" max="150" value={d.serveSpeed}
            onChange={(e) => update('serveSpeed', parseInt(e.target.value))} />
        </div>
        <div className="form-group">
          <label>Serve Placement</label>
          <div className="chip-group">
            {SERVE_PLACEMENTS.map((p) => (
              <button type="button" key={p}
                className={`chip ${d.servePlacement.includes(p) ? 'chip-active' : ''}`}
                onClick={() => toggleMulti('servePlacement', p)}>{p}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="form-section" style={{ flex: 1 }}>
        <h4>Return Stats</h4>
        <div className="form-group">
          <label>Return % ({d.returnPct}%)</label>
          <input type="range" min="0" max="100" value={d.returnPct}
            onChange={(e) => update('returnPct', parseInt(e.target.value))} />
        </div>
        <div className="form-group">
          <label>Return Placement</label>
          <div className="chip-group">
            {RETURN_PLACEMENTS.map((p) => (
              <button type="button" key={p}
                className={`chip ${d.returnPlacement.includes(p) ? 'chip-active' : ''}`}
                onClick={() => toggleMulti('returnPlacement', p)}>{p}</button>
            ))}
          </div>
        </div>

        <h4>Break Points</h4>
        <div className="form-row">
          <div className="form-group">
            <label>Break Points Won</label>
            <input type="number" min="0" value={d.breakPointsWon}
              onChange={(e) => update('breakPointsWon', e.target.value === '' ? '' : parseInt(e.target.value))} />
          </div>
          <div className="form-group">
            <label>Break Points Saved</label>
            <input type="number" min="0" value={d.breakPointsSaved}
              onChange={(e) => update('breakPointsSaved', e.target.value === '' ? '' : parseInt(e.target.value))} />
          </div>
        </div>
      </div>
    </div>
  )

  const ShotStats = () => (
    <div className="step-container">
      <div className="form-group">
        <label>Winners</label>
        <input type="number" min="0" value={d.winners}
          onChange={(e) => update('winners', e.target.value === '' ? '' : parseInt(e.target.value))} />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Unforced Errors</label>
          <input type="number" min="0" value={d.unforcedErrors}
            onChange={(e) => update('unforcedErrors', e.target.value === '' ? '' : parseInt(e.target.value))} />
        </div>
        <div className="form-group">
          <label>Forced Errors</label>
          <input type="number" min="0" value={d.forcedErrors}
            onChange={(e) => update('forcedErrors', e.target.value === '' ? '' : parseInt(e.target.value))} />
        </div>
      </div>
      <div className="form-group">
        <label>Avg Rally Length</label>
        <input type="number" min="0" value={d.avgRallyLength}
          onChange={(e) => update('avgRallyLength', e.target.value === '' ? '' : parseInt(e.target.value))} />
      </div>
      <div className="form-group">
        <label>Net Points Won</label>
        <input type="number" min="0" value={d.netPointsWon}
          onChange={(e) => update('netPointsWon', e.target.value === '' ? '' : parseInt(e.target.value))} />
      </div>
    </div>
  )

  const Step4 = () => (
    <div className="step-container">
      <div className="step-title">Performance Statistics</div>
      {StatsSubTabs()}
      <div className="sub-wizard-content">
        {statsSubstep === 1 ? ServeReturnStats() : ShotStats()}
      </div>

      <hr />
      <div className="nav-buttons">
        <button type="button" className="btn btn-secondary"
          onClick={() => {
            if (statsSubstep === 1) setStep(3)
            else setStatsSubstep((s) => s - 1)
          }}>
          {statsSubstep === 1 ? 'Back to Media' : 'Previous'}
        </button>
        <span className="text-muted">Step {statsSubstep} of 2</span>
        <button type="button" className="btn btn-primary"
          onClick={() => {
            if (statsSubstep < 2) setStatsSubstep((s) => s + 1)
            else { setStep(5); setStatsSubstep(1) }
          }}>
          {statsSubstep < 2 ? 'Next' : 'Continue to Review'}
        </button>
      </div>
    </div>
  )

  // --- Step 5: Review & Submit ---
  const Step5 = () => {
    const score = `${d.playerSet1}-${d.oppSet1}, ${d.playerSet2}-${d.oppSet2}` +
      (d.playerSet3 > 0 || d.oppSet3 > 0 ? `, ${d.playerSet3}-${d.oppSet3}` : '')

    return (
      <div className="step-container">
        <div className="step-title">Review & Submit</div>

        <div className="form-group">
          <label>Mental Game <span style={{ color: '#ef4444' }}>*</span></label>
          <textarea rows="3" value={d.mentalGame}
            onChange={(e) => update('mentalGame', e.target.value)}
            placeholder="Confident? Nervous? Focused?" />
        </div>
        <div className="form-group">
          <label>Match Description <span style={{ color: '#ef4444' }}>*</span></label>
          <textarea rows="3" value={d.matchDescription}
            onChange={(e) => update('matchDescription', e.target.value)}
            placeholder="Key moments, turning points, what worked, what didn't..." />
        </div>

        <hr />
        <h3>Match Summary</h3>

        <div className="summary-grid">
          <div className="summary-card">
            <div className="summary-label">Date</div>
            <div className="summary-value">{d.matchDate}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Surface</div>
            <div className="summary-value">{d.surfaceType}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Result</div>
            <div className="summary-value">{d.result === 'W' ? 'WIN' : 'LOSS'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Score</div>
            <div className="summary-value">{score}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Opponent</div>
            <div className="summary-value">{d.opponentName || 'Not specified'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">UTR</div>
            <div className="summary-value">{d.utrRating}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">1st Serve %</div>
            <div className="summary-value">{d.firstServePct}%</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Winners / UE</div>
            <div className="summary-value">{d.winners} / {d.unforcedErrors}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Video</div>
            <div className="summary-value">{d.uploadedVideo ? 'Yes' : 'No'}</div>
          </div>
        </div>
      </div>
    )
  }

  // --- Voice Mode: Review Screen ---
  const VoiceReviewScreen = () => {
    const ed = extractedData
    const score = `${ed.playerSet1 || 0}-${ed.oppSet1 || 0}, ${ed.playerSet2 || 0}-${ed.oppSet2 || 0}` +
      ((ed.playerSet3 || 0) > 0 || (ed.oppSet3 || 0) > 0 ? `, ${ed.playerSet3 || 0}-${ed.oppSet3 || 0}` : '')

    return (
      <div className="voice-mode-container">
        <div className="voice-header">
          <h2>Review Match Data</h2>
          <button className="btn btn-secondary" onClick={() => setVoiceReview(false)}>Back to Chat</button>
        </div>

        <div className="summary-grid">
          <div className="summary-card">
            <div className="summary-label">Date</div>
            <div className="summary-value">{ed.matchDate || 'Not specified'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Surface</div>
            <div className="summary-value">{ed.surfaceType || 'Hard'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Result</div>
            <div className="summary-value">{ed.result === 'W' ? 'WIN' : 'LOSS'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Score</div>
            <div className="summary-value">{score}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Opponent</div>
            <div className="summary-value">{ed.opponentName || 'Not specified'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">UTR</div>
            <div className="summary-value">{ed.utrRating || 'UR'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Ranking</div>
            <div className="summary-value">{ed.oppRanking || '—'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Playing Style</div>
            <div className="summary-value">{(ed.oppPlayingStyle || []).join(', ') || '—'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">1st Serve %</div>
            <div className="summary-value">{ed.firstServePct || 0}%</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">1st Serve Won %</div>
            <div className="summary-value">{ed.firstServePctWon || 0}%</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">2nd Serve %</div>
            <div className="summary-value">{ed.secondServePct || 0}%</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Aces</div>
            <div className="summary-value">{ed.aces || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Double Faults</div>
            <div className="summary-value">{ed.doubleFaults || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Serve Speed</div>
            <div className="summary-value">{ed.serveSpeed || 0} MPH</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Return %</div>
            <div className="summary-value">{ed.returnPct || 0}%</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Winners</div>
            <div className="summary-value">{ed.winners || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Unforced Errors</div>
            <div className="summary-value">{ed.unforcedErrors || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Forced Errors</div>
            <div className="summary-value">{ed.forcedErrors || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Avg Rally Length</div>
            <div className="summary-value">{ed.avgRallyLength || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Net Points Won</div>
            <div className="summary-value">{ed.netPointsWon || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Break Points Won</div>
            <div className="summary-value">{ed.breakPointsWon || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Break Points Saved</div>
            <div className="summary-value">{ed.breakPointsSaved || 0}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Mental Game</div>
            <div className="summary-value">{ed.mentalGame || '—'}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Description</div>
            <div className="summary-value">{ed.matchDescription || '—'}</div>
          </div>
        </div>

        <div className="nav-buttons" style={{ marginTop: '1.5rem' }}>
          <button className="btn btn-secondary" onClick={() => setVoiceReview(false)}>Back to Chat</button>
          <button className="btn btn-primary" onClick={submitFromVoice} disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit Match'}
          </button>
        </div>
      </div>
    )
  }

  // --- Voice Mode: Chat UI ---
  const VoiceChatUI = () => {
    const isBusy = voiceStreaming || speaking
    const lastAssistant = [...voiceMessages].reverse().find((m) => m.role === 'assistant')
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const isNonSafariIOS = isIOS && (/CriOS|FxiOS|OPiOS/.test(navigator.userAgent) ||
      (!!window.chrome) ||
      (/Chrome/.test(navigator.userAgent) && !/Safari/.test(navigator.userAgent)))
    const hasMic = !micBlocked && !isNonSafariIOS && !!(window.SpeechRecognition || window.webkitSpeechRecognition)

    return (
      <div className="voice-mode-container">
        <div className="voice-header">
          <div>
            <h2>Voice Mode</h2>
            <p className="text-muted">Speak with your AI coach to log your match</p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {voiceMessages.length >= 4 && (
              <button className="btn btn-primary" onClick={extractAndReview} disabled={isBusy || listening || extracting}>
                {extracting ? 'Extracting...' : 'Review & Submit'}
              </button>
            )}
            <button className="btn btn-secondary" onClick={exitVoiceMode}>Back to Form</button>
          </div>
        </div>

        {/* Current AI message display */}
        <div className="voice-ai-bubble">
          <div className={`voice-ai-icon ${speaking ? 'voice-speaking' : ''}`}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
          </div>
          <p className="voice-ai-text">
            {lastAssistant?.content || ''}
            {voiceStreaming && <span className="cursor-blink">|</span>}
          </p>
          {speaking && <div className="voice-status-label">Speaking...</div>}
        </div>

        {/* Center mic area */}
        <div className="voice-mic-area">
          {hasMic ? (
            <>
              {listening && liveTranscript && (
                <div className="voice-live-transcript">{liveTranscript}</div>
              )}
              <button
                className={`voice-mic-btn ${listening ? 'voice-mic-active' : ''}`}
                onClick={listening ? stopListeningAndSend : async () => { await unlockAudio(); startListening() }}
                disabled={isBusy}
              >
                {listening ? (
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                ) : (
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                )}
              </button>
              <div className="voice-mic-label">
                {isBusy ? 'AI is responding...' : listening ? 'Listening — tap to send' : 'Tap to speak'}
              </div>
            </>
          ) : (
            <div className="voice-no-mic">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.4 }}><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
              <p className="voice-no-mic-title">Microphone unavailable</p>
              <p className="voice-no-mic-sub">On iPhone/iPad, voice mode only works in Safari.<br/>Use the text box below, or open this page in Safari for full voice mode.</p>
            </div>
          )}
        </div>

        {/* Scrollable transcript history */}
        <div className="voice-transcript-history">
          {voiceMessages.map((msg, i) => (
            <div key={i} className={`voice-transcript-line ${msg.role}`}>
              <span className="voice-transcript-role">{msg.role === 'user' ? 'You' : 'MatchGenie'}:</span>
              {' '}{msg.content}
            </div>
          ))}
          <div ref={voiceEndRef} />
        </div>

        {/* Fallback text input */}
        <form className="voice-fallback-input" onSubmit={(e) => { e.preventDefault(); if (voiceInput.trim()) { sendVoiceMessage(voiceInput.trim()); setVoiceInput('') } }}>
          <input
            type="text"
            value={voiceInput}
            onChange={(e) => setVoiceInput(e.target.value)}
            placeholder="Or type your response..."
            disabled={isBusy}
          />
          <button type="submit" className="crush-send-btn" disabled={isBusy || !voiceInput.trim()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </form>
      </div>
    )
  }

  // --- Main Render ---
  if (voiceMode) {
    return (
      <div className="log-page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1>Log Match</h1>
            <p className="text-muted">AI-assisted match logging</p>
          </div>
          <Link to="/matches" className="btn btn-primary" style={{ flexShrink: 0 }}>View Matches</Link>
        </div>

        {message && <div className={`alert ${message.includes('Failed') ? 'alert-error' : 'alert-success'}`}>{message}</div>}

        {voiceReview && extractedData ? <VoiceReviewScreen /> : <VoiceChatUI />}
      </div>
    )
  }

  return (
    <div className="log-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Log Match</h1>
          <p className="text-muted">Step-by-step match logging wizard</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexShrink: 0 }}>
          <button className="btn btn-voice" onClick={activateVoiceMode}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '0.4rem' }}><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            Voice Mode
          </button>
          <Link to="/matches" className="btn btn-primary" style={{ flexShrink: 0 }}>View Matches</Link>
        </div>
      </div>

      {message && <div className={`alert ${message.includes('Failed') ? 'alert-error' : 'alert-success'}`}>{message}</div>}

      {/* Wizard */}
      {ProgressStepper()}

      {step === 1 && Step1()}
      {step === 2 && Step2()}
      {step === 3 && Step3()}
      {step === 4 && Step4()}
      {step === 5 && Step5()}

      {/* Navigation (hidden on step 4 which has its own sub-nav) */}
      {validationError && <div className="alert alert-error">{validationError}</div>}
      {step !== 4 && (
        <div className="nav-buttons">
          <div>
            {step > 1 && (
              <button type="button" className="btn btn-secondary" onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
            )}
          </div>
          <div>
            {step < 5 ? (
              <button type="button" className="btn btn-primary"
                onClick={() => {
                  if (step === 1) {
                    const hasScore = d.playerSet1 > 0 || d.oppSet1 > 0 || d.playerSet2 > 0 || d.oppSet2 > 0
                    if (!hasScore) { setValidationError('Score is required.'); return }
                  }
                  if (step === 2) {
                    if (!d.opponentName.trim()) { setValidationError('Opponent Name is required.'); return }
                    if (d.oppPlayingStyle.length === 0) { setValidationError('Opponent Playing Style is required.'); return }
                  }
                  setValidationError('')
                  setStep((s) => s + 1)
                  if (step + 1 === 4) setStatsSubstep(1)
                }}>
                Next
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={submitting}
                onClick={() => {
                  if (!d.matchDescription.trim()) { setValidationError('Match Description is required.'); return }
                  if (!d.mentalGame.trim()) { setValidationError('Mental Game is required.'); return }
                  setValidationError('')
                  handleSubmit()
                }}>
                {submitting ? 'Submitting...' : 'Submit Match'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
