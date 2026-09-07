import { useState, useEffect, useRef, useMemo } from 'react'
import api from '../api/client'
import { useAuth } from '../context/AuthContext'

// ── Shared helpers ────────────────────────────────────────────────────────────

const formatDate = (dateStr) => {
  const d = new Date(dateStr)
  if (isNaN(d)) return dateStr || 'Unknown Date'
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).toUpperCase()
}

const formatVideoAnalysisDate = (dateStr) => {
  const value = String(dateStr || '')
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(dateStr)
  if (isNaN(d)) return dateStr || "Date unavailable"
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  })
}

function VideoAnalysisAccordionHeader({ opponent, date, expanded, onToggle, status }) {
  return (
    <button
      type="button"
      className="video-analysis-accordion-header"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="video-analysis-accordion-summary">
        <strong>vs {opponent || "Opponent"}</strong>
        <span>{formatVideoAnalysisDate(date)}</span>
        {status && <span className="video-analysis-accordion-status">{status}</span>}
      </span>
      <span className={`video-analysis-accordion-chevron${expanded ? " video-analysis-accordion-chevron--open" : ""}`} aria-hidden="true">▼</span>
    </button>
  )
}

const ANALYSIS_JOBS_KEY = 'matchgenie-active-video-analyses-v2'
const ANALYSIS_JOBS_KEY_PREFIX = `${ANALYSIS_JOBS_KEY}:user:`
const LEGACY_ANALYSIS_JOB_KEY = 'matchgenie-active-video-analysis'

const readStoredAnalyses = (storageKey) => {
  if (!storageKey) return []
  try {
    const storedValue = localStorage.getItem(storageKey)
    if (storedValue) {
      const stored = JSON.parse(storedValue)
      if (Array.isArray(stored)) return stored.filter((job) => job?.task_id)
    }
    return []
  } catch {
    return []
  }
}

const formatVideoTime = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`
}

const parseVideoTime = (value) => {
  const text = String(value ?? '').trim()
  if (!text || !/^\d+(?::\d{1,2}){0,2}$/.test(text)) return Number.NaN

  const parts = text.split(':').map(Number)
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return Number.NaN
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    return seconds < 60 ? (minutes * 60) + seconds : Number.NaN
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return minutes < 60 && seconds < 60
      ? (hours * 3600) + (minutes * 60) + seconds
      : Number.NaN
  }
  return Number.NaN
}

function TimecodeInput({ id, value, optional = false, placeholder, onChange }) {
  const focusedRef = useRef(false)
  const [text, setText] = useState(
    value == null ? '' : formatVideoTime(value)
  )
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (focusedRef.current) return
    if (value == null) {
      setText('')
      setInvalid(false)
      return
    }
    if (!Number.isFinite(value)) return
    setText(formatVideoTime(value))
    setInvalid(false)
  }, [value])

  const update = (nextText) => {
    setText(nextText)
    setInvalid(false)
    if (optional && nextText.trim() === '') {
      onChange(null)
      return
    }
    const seconds = parseVideoTime(nextText)
    onChange(Number.isFinite(seconds) ? seconds : Number.NaN)
  }

  const finishEditing = () => {
    focusedRef.current = false
    if (optional && text.trim() === '') {
      setInvalid(false)
      onChange(null)
      return
    }
    const seconds = parseVideoTime(text)
    if (!Number.isFinite(seconds)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setText(formatVideoTime(seconds))
    onChange(seconds)
  }

  return (
    <>
      <input
        id={id}
        className="form-input"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck="false"
        placeholder={placeholder}
        value={text}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
        onFocus={() => { focusedRef.current = true }}
        onChange={(event) => update(event.target.value)}
        onBlur={finishEditing}
      />
      <span id={`${id}-hint`} className={invalid ? 'video-upload-error' : 'vp-field-hint'}>
        {invalid ? 'Enter a time like 3:10 or 1:03:10.' : 'Use M:SS or H:MM:SS.'}
      </span>
    </>
  )
}

const youtubeVideoId = (value) => {
  try {
    const url = new URL(String(value || '').trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    let id = ''
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0] || ''
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      const parts = url.pathname.split('/').filter(Boolean)
      if (url.pathname.replace(/\/$/, '') === '/watch') id = url.searchParams.get('v') || ''
      else if (['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1] || ''
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : ''
  } catch {
    return ''
  }
}

const sourceIsReady = (state) => {
  if (state.sourceType === 'youtube') {
    if (!youtubeVideoId(state.youtubeUrl) || !state.youtubeAuthorized) return false
    if (!Number.isFinite(state.startTime) || state.startTime < 0) return false
    return state.endTime == null || (
      Number.isFinite(state.endTime) && state.endTime > state.startTime
    )
  }
  return Boolean(state.file && Number.isFinite(state.endTime) && state.endTime > state.startTime)
}

const hasFreshArtifactUrl = (artifact, refreshBufferMs = 5 * 60 * 1000) => {
  const expiresAt = Date.parse(artifact?.expires_at || '')
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > refreshBufferMs
}

const artifactRefreshDelay = (analysis) => {
  const artifacts = [
    analysis?.trimmed_video,
    ...(Array.isArray(analysis?.rallies) ? analysis.rallies : []),
    ...(Array.isArray(analysis?.winner_clips) ? analysis.winner_clips : []),
    analysis?.stats,
  ].filter(Boolean)
  const expirations = artifacts
    .flatMap((artifact) => [artifact?.expires_at, artifact?.fallback_expires_at])
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite)

  // Refresh five minutes before the earliest signed URL expires. The fallback
  // also renews legacy manifests whose artifacts do not expose expires_at.
  if (!expirations.length) return 5.5 * 60 * 60 * 1000
  return Math.max(30 * 1000, Math.min(...expirations) - Date.now() - 5 * 60 * 1000)
}

const artifactExpiryKey = (analysis) => [
  analysis?.trimmed_video,
  ...(Array.isArray(analysis?.rallies) ? analysis.rallies : []),
  ...(Array.isArray(analysis?.winner_clips) ? analysis.winner_clips : []),
  analysis?.stats,
]
  .filter(Boolean)
  .flatMap((artifact) => [artifact?.expires_at, artifact?.fallback_expires_at])
  .filter(Boolean)
  .sort()
  .join('|')

function ResilientVideo({
  artifact,
  className,
  onArtifactError,
  onVideoTimeUpdate,
  onVideoElement,
  controlsList,
  onDoubleClick,
  clipStartSec,
  clipEndSec,
}) {
  const videoRef = useRef(null)
  const primaryUrl = artifact?.url || ''
  const fallbackUrl = artifact?.fallback_url || ''
  const [usingFallback, setUsingFallback] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !onVideoTimeUpdate || !video.requestVideoFrameCallback) return undefined

    let callbackId
    const reportFrameTime = (_now, metadata) => {
      // mediaTime is the presentation timestamp of the frame currently being
      // displayed, so review overlays stay aligned with the rendered video.
      onVideoTimeUpdate(metadata.mediaTime)
      callbackId = video.requestVideoFrameCallback(reportFrameTime)
    }
    callbackId = video.requestVideoFrameCallback(reportFrameTime)
    return () => video.cancelVideoFrameCallback?.(callbackId)
  }, [onVideoTimeUpdate, primaryUrl, fallbackUrl, usingFallback])

  useEffect(() => {
    setUsingFallback(false)
    setFailed(false)
  }, [primaryUrl, fallbackUrl])

  const setVideoRef = (element) => {
    videoRef.current = element
    onVideoElement?.(element)
  }

  const requestRecovery = () => {
    onArtifactError?.()
    if (!usingFallback && fallbackUrl && fallbackUrl !== primaryUrl) {
      setFailed(false)
      setUsingFallback(true)
      return
    }
    setFailed(true)
  }

  const handleLoadedMetadata = (event) => {
    const video = event.currentTarget
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      requestRecovery()
      return
    }
    const requestedStart = Number(
      Number.isFinite(Number(clipStartSec))
        ? clipStartSec
        : usingFallback ? artifact?.fallback_start_sec : 0
    )
    const start = Number.isFinite(requestedStart)
      ? Math.min(Math.max(0, requestedStart), Math.max(0, video.duration - 0.05))
      : 0
    if (start > 0.01) video.currentTime = start
  }

  const handleTimeUpdate = (event) => {
    const start = Number.isFinite(Number(clipStartSec)) ? Number(clipStartSec) : 0
    onVideoTimeUpdate?.(Math.max(0, event.currentTarget.currentTime - start))
    const end = Number(
      Number.isFinite(Number(clipEndSec))
        ? clipEndSec
        : usingFallback ? artifact?.fallback_end_sec : NaN
    )
    if (Number.isFinite(end) && end > 0 && event.currentTarget.currentTime >= end) {
      event.currentTarget.pause()
    }
  }

  const handlePlay = (event) => {
    const start = Number(clipStartSec)
    const end = Number(clipEndSec)
    if (Number.isFinite(start) && Number.isFinite(end) &&
        event.currentTarget.currentTime >= end - 0.05) {
      event.currentTarget.currentTime = start
    }
  }

  const activeUrl = usingFallback ? fallbackUrl : primaryUrl
  if (!activeUrl || failed) {
    return (
      <div className={`${className} video-result-player--unavailable`} role="status">
        Video temporarily unavailable. Refreshing its secure link…
      </div>
    )
  }

  return (
    <div className="video-resilient-player">
      <video
        ref={setVideoRef}
        key={activeUrl}
        className={className}
        controls
        controlsList={controlsList}
        preload="metadata"
        src={activeUrl}
        onError={requestRecovery}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPlay={handlePlay}
        onDoubleClick={onDoubleClick}
      >
        Your browser does not support video playback.
      </video>
      {usingFallback && (
        <span className="video-playback-fallback-note">Recovered from the pose-labeled rally</span>
      )}
    </div>
  )
}

const SHOT_LABELS = ['forehand', 'backhand', 'serve', 'random movement']
function parseCsvRow(line) {
  const values = []
  let value = ''
  let quoted = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      values.push(value)
      value = ''
    } else {
      value += char
    }
  }
  values.push(value)
  return values
}

function reviewEventTime(event) {
  const normalizedTime = Number(event._review_time_s)
  if (Number.isFinite(normalizedTime)) return normalizedTime
  const displayTime = Number(event.display_time_s)
  if (Number.isFinite(displayTime)) return displayTime
  const contactTime = Number(event.time_s)
  return Number.isFinite(contactTime) ? contactTime : NaN
}

function ShotReviewOverlay({ event, correction, onSave, className = '' }) {
  if (!event) return null
  return (
    <div
      className={`rally-shot-overlay${className ? ` ${className}` : ''}${correction === 'correct' ? ' rally-shot-overlay--ok' : correction ? ' rally-shot-overlay--wrong' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="rally-shot-overlay-info">
        {event.playerName} · <strong>{event.label}</strong>
      </span>
      <div className="rally-shot-overlay-btns">
        <button
          type="button"
          data-review-action="correct"
          className={`rally-overlay-btn${correction === 'correct' ? ' rally-overlay-btn--active-ok' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSave(event.frame, event.player, event.label, 'correct')
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          title="Correct"
        >✓</button>
        <button
          type="button"
          data-review-action="wrong"
          className={`rally-overlay-btn rally-overlay-btn--bad${correction && correction !== 'correct' ? ' rally-overlay-btn--active-bad' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSave(event.frame, event.player, event.label, correction && correction !== 'correct' ? correction : 'forehand')
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          title="Wrong"
        >✗</button>
        {correction && correction !== 'correct' && (
          <select
            className="rally-overlay-select"
            value={correction}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onSave(event.frame, event.player, event.label, e.target.value)}
          >
            {SHOT_LABELS.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}

function RallyVideoCard({ rally, taskId, onArtifactError, playerNames, annotationsEnabled, cleanMatch }) {
  const [events, setEvents]       = useState(null)
  const [corrections, setCorrections] = useState({})
  const [currentTime, setCurrentTime] = useState(0)
  const wrapperRef = useRef(null)
  const videoElRef = useRef(null)
  const fullscreenReviewRef = useRef(null)
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false)

  useEffect(() => {
    if (!rally.shot_events_blob) {
      setEvents([])
      return
    }
    api.get('/video/shot-events', { params: { blob_name: rally.shot_events_blob }, responseType: 'text' })
      .then((r) => r.data)
      .then((text) => {
        const lines = text.trim().split(/\r?\n/)
        if (!lines[0]) {
          setEvents([])
          return
        }
        const headers = parseCsvRow(lines[0])
        const parsed = lines.slice(1).map((line) => {
          const vals = parseCsvRow(line)
          return Object.fromEntries(headers.map((h, i) => [h.trim(), (vals[i] || '').trim()]))
        }).filter((e) => e.label && e.label !== 'idle' && Number.isFinite(Number(e.time_s)))
        const duration = Number(rally.duration_sec)
        const rallyStart = Number(rally.start_sec)
        const rawTimes = parsed.map(reviewEventTime).filter(Number.isFinite)
        const timestampsAreAbsolute = (
          Number.isFinite(duration) && duration > 0 &&
          Number.isFinite(rallyStart) && rallyStart > 0 &&
          rawTimes.some((time) => time > duration + 0.5) &&
          rawTimes.filter((time) => time - rallyStart >= -0.5 && time - rallyStart <= duration + 0.5).length >=
            Math.max(1, Math.ceil(rawTimes.length * 0.75))
        )
        setEvents(parsed.map((event) => ({
          ...event,
          _review_time_s: reviewEventTime(event) - (timestampsAreAbsolute ? rallyStart : 0),
        })))
      })
      .catch(() => setEvents([]))
  }, [rally.shot_events_blob, rally.start_sec, rally.duration_sec])

  useEffect(() => {
    if (!taskId) return
    api.get(`/video/corrections/${taskId}`)
      .then((res) => {
        const map = {}
        for (const c of res.data.corrections || []) {
          if (c.rally_number === rally.number) {
            map[`${c.frame}-${c.player}`] = c.corrected ?? 'correct'
          }
        }
        setCorrections(map)
      })
      .catch(() => {})
  }, [taskId, rally.number])

  const activeEvent = useMemo(() => {
    if (!events) return null
    let latest = null
    let latestTime = -Infinity
    for (const ev of events) {
      const t = reviewEventTime(ev)
      if (!Number.isFinite(t)) continue
      // Do not show a shot before its detected frame. Once reached, keep that
      // shot selected until the next detection so pausing preserves feedback.
      if (t <= currentTime && t >= latestTime) {
        latestTime = t
        latest = ev
      }
    }
    return latest ? {
      ...latest,
      playerName: latest.player === '0' ? playerNames.p1 : playerNames.p2,
    } : null
  }, [currentTime, events, playerNames.p1, playerNames.p2])

  const saveCorrection = (frame, player, detected, corrected) => {
    const keepPaused = () => videoElRef.current?.pause()
    keepPaused()
    window.requestAnimationFrame(keepPaused)
    window.setTimeout(keepPaused, 0)
    window.setTimeout(keepPaused, 100)
    const key = `${frame}-${player}`
    setCorrections((prev) => ({ ...prev, [key]: corrected }))
    api.post('/video/correction', {
      task_id: taskId, rally_number: rally.number,
      frame: Number(frame), player: Number(player),
      detected, corrected: corrected === 'correct' ? null : corrected,
      keypoints_json: activeEvent?.keypoints_json || null,
    }).catch(() => {})
  }

  const activeKey        = activeEvent ? `${activeEvent.frame}-${activeEvent.player}` : null
  const activeCorrection = activeKey ? corrections[activeKey] : null

  useEffect(() => {
    const updateNativeFullscreen = () => {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement
      setIsVideoFullscreen(fullscreenElement === videoElRef.current)
    }
    document.addEventListener('fullscreenchange', updateNativeFullscreen)
    document.addEventListener('webkitfullscreenchange', updateNativeFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', updateNativeFullscreen)
      document.removeEventListener('webkitfullscreenchange', updateNativeFullscreen)
    }
  }, [])

  useEffect(() => {
    const panel = fullscreenReviewRef.current
    if (!panel?.showPopover || !panel?.hidePopover) return
    const open = panel.matches(':popover-open')
    if (isVideoFullscreen && activeEvent && !open) panel.showPopover()
    if ((!isVideoFullscreen || !activeEvent) && open) panel.hidePopover()
  }, [isVideoFullscreen, activeEvent])

  useEffect(() => {
    if (!isVideoFullscreen || !activeEvent) return undefined

    const actionAtPoint = (clientX, clientY) => {
      const buttons = fullscreenReviewRef.current?.querySelectorAll('[data-review-action]') || []
      let matched = null
      buttons.forEach((button) => {
        const rect = button.getBoundingClientRect()
        const hovered = (
          clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom
        )
        button.classList.toggle('rally-overlay-btn--captured-hover', hovered)
        if (hovered) matched = button.dataset.reviewAction
      })
      return matched
    }

    const handlePointerMove = (event) => {
      actionAtPoint(event.clientX, event.clientY)
    }
    const handlePointerDown = (event) => {
      const action = actionAtPoint(event.clientX, event.clientY)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      const corrected = action === 'correct'
        ? 'correct'
        : (activeCorrection && activeCorrection !== 'correct' ? activeCorrection : 'forehand')
      saveCorrection(activeEvent.frame, activeEvent.player, activeEvent.label, corrected)
    }
    const blockVideoToggle = (event) => {
      const action = actionAtPoint(event.clientX, event.clientY)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      videoElRef.current?.pause()
    }

    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', blockVideoToggle, true)
    document.addEventListener('click', blockVideoToggle, true)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', blockVideoToggle, true)
      document.removeEventListener('click', blockVideoToggle, true)
    }
  }, [isVideoFullscreen, activeEvent, activeCorrection])

  return (
    <div className="rally-video-wrapper" ref={wrapperRef}>
      <ResilientVideo
        artifact={annotationsEnabled ? rally : cleanMatch}
        className="video-result-player"
        onArtifactError={onArtifactError}
        onVideoTimeUpdate={setCurrentTime}
        onVideoElement={(element) => { videoElRef.current = element }}
        controlsList="nodownload noremoteplayback"
        clipStartSec={annotationsEnabled ? undefined : Number(rally.start_sec)}
        clipEndSec={annotationsEnabled ? undefined : Number(rally.end_sec)}
      />
      {annotationsEnabled && !isVideoFullscreen && (
        <ShotReviewOverlay event={activeEvent} correction={activeCorrection} onSave={saveCorrection} />
      )}
      {annotationsEnabled && (
        <div ref={fullscreenReviewRef} popover="manual" className="rally-fullscreen-review-popover">
          <ShotReviewOverlay
            event={activeEvent}
            correction={activeCorrection}
            onSave={saveCorrection}
            className="rally-shot-overlay--fullscreen"
          />
        </div>
      )}
    </div>
  )
}

function RallyCorrections({ rally, taskId }) {
  const [events, setEvents]           = useState(null)
  const [corrections, setCorrections] = useState({}) // key: `${frame}-${player}` → corrected label or 'correct'
  const [open, setOpen]               = useState(false)

  useEffect(() => {
    if (!open || !rally.shot_events_blob) return
    let cancelled = false
    api.get('/video/shot-events', { params: { blob_name: rally.shot_events_blob }, responseType: 'text' })
      .then((r) => r.data)
      .then((text) => {
        if (cancelled) return
        const lines = text.trim().split('\n')
        const headers = lines[0].split(',')
        const parsed = lines.slice(1).map((line) => {
          const vals = line.split(',')
          return Object.fromEntries(headers.map((h, i) => [h.trim(), (vals[i] || '').trim()]))
        }).filter((e) => e.label && e.label !== 'idle' && e.label !== 'serve' || e.label === 'serve')
        setEvents(parsed)
      })
      .catch(() => setEvents([]))
    return () => { cancelled = true }
  }, [open, rally.shot_events_blob])

  // Load existing corrections for this rally
  useEffect(() => {
    if (!open || !taskId) return
    api.get(`/video/corrections/${taskId}`)
      .then((res) => {
        const map = {}
        for (const c of res.data.corrections || []) {
          if (c.rally_number === rally.number) {
            map[`${c.frame}-${c.player}`] = c.corrected ?? 'correct'
          }
        }
        setCorrections(map)
      })
      .catch(() => {})
  }, [open, taskId, rally.number])

  const saveCorrection = (frame, player, detected, corrected) => {
    const key = `${frame}-${player}`
    setCorrections((prev) => ({ ...prev, [key]: corrected }))
    api.post('/video/correction', {
      task_id:      taskId,
      rally_number: rally.number,
      frame:        Number(frame),
      player:       Number(player),
      detected,
      corrected:    corrected === 'correct' ? null : corrected,
    }).catch(() => {})
  }

  if (!rally.shot_events_blob) return null

  return (
    <div className="rally-corrections">
      <button
        type="button"
        className="rally-corrections-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▲ Hide' : '▼ Review detections'}
      </button>
      {open && (
        <div className="rally-corrections-list">
          {events === null && <span className="rally-corrections-loading">Loading…</span>}
          {events && events.length === 0 && <span className="rally-corrections-loading">No shots detected.</span>}
          {events && events.map((ev) => {
            const key = `${ev.frame}-${ev.player}`
            const state = corrections[key]
            const playerLabel = ev.player === '0' ? 'P1' : 'P2'
            return (
              <div key={key} className={`rally-correction-row ${state ? (state === 'correct' ? 'rally-correction-row--ok' : 'rally-correction-row--wrong') : ''}`}>
                <span className="rally-correction-meta">{playerLabel} · t={Number(ev.time_s).toFixed(1)}s</span>
                <span className="rally-correction-label">{ev.label}</span>
                <div className="rally-correction-actions">
                  <button
                    type="button"
                    className={`rally-correction-btn ${state === 'correct' ? 'rally-correction-btn--active' : ''}`}
                    onClick={() => saveCorrection(ev.frame, ev.player, ev.label, 'correct')}
                    title="Mark correct"
                  >✓</button>
                  <button
                    type="button"
                    className={`rally-correction-btn rally-correction-btn--wrong ${state && state !== 'correct' ? 'rally-correction-btn--active' : ''}`}
                    onClick={() => saveCorrection(ev.frame, ev.player, ev.label, state && state !== 'correct' ? state : 'forehand')}
                    title="Mark wrong"
                  >✗</button>
                  {state && state !== 'correct' && (
                    <select
                      className="rally-correction-select"
                      value={state}
                      onChange={(e) => saveCorrection(ev.frame, ev.player, ev.label, e.target.value)}
                    >
                      {SHOT_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AnalysisVideos({ analysis, taskId, showTrimmed = true, onArtifactError }) {
  const trimmed = analysis?.trimmed_video
  const allRallies = analysis?.rallies || []
  const playerNames = {
    p1: analysis?.username || 'Player',
    p2: analysis?.opponent_name || 'Opponent',
  }
  const [serveFilter, setServeFilter] = useState('all')
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true)
  const rallies = serveFilter === 'all'
    ? allRallies
    : allRallies.filter((r) => r.serving_player === serveFilter)
  const winnerClips = analysis?.winner_clips || []
  const winnerGroups = [
    { type: 'forehand', title: 'Forehand Winners' },
    { type: 'backhand', title: 'Backhand Winners' },
    { type: 'serve', title: 'Serve Winners' },
  ].map((group) => ({
    ...group,
    clips: winnerClips.filter((clip) => clip.shot_type === group.type),
  }))
  if (!trimmed && rallies.length === 0 && winnerClips.length === 0) return null

  return (
    <div className="video-analysis-results">
      {showTrimmed && trimmed?.url && (
        <section className="video-result-section">
          <div className="video-result-heading">
            <div>
              <span className="video-result-eyebrow">Edited match</span>
              <h3>Trimmed Match Video</h3>
            </div>
            <span className="video-ready-pill">Ready</span>
          </div>
          <ResilientVideo
            artifact={trimmed}
            className="video-result-player video-result-player--match"
            onArtifactError={onArtifactError}
          />
        </section>
      )}

      {allRallies.length > 0 && (
        <section className="video-result-section">
          <div className="video-result-heading">
            <div>
              <span className="video-result-eyebrow">Pose-labeled clips</span>
              <h3>Extracted Rallies</h3>
            </div>
            <div className="video-rallies-header-right">
              <button
                type="button"
                role="switch"
                aria-checked={annotationsEnabled}
                className={`video-annotations-toggle${annotationsEnabled ? ' video-annotations-toggle--on' : ''}`}
                onClick={() => setAnnotationsEnabled((enabled) => !enabled)}
              >
                Annotations {annotationsEnabled ? 'On' : 'Off'}
              </button>
              <select
                className="video-serve-filter"
                value={serveFilter}
                onChange={(e) => setServeFilter(e.target.value)}
              >
                <option value="all">All Rallies</option>
                <option value="P1">{playerNames.p1} Serves</option>
                <option value="P2">{playerNames.p2} Serves</option>
              </select>
              <span className="video-rally-count">{rallies.length} {rallies.length === 1 ? 'rally' : 'rallies'}</span>
            </div>
          </div>
          <div className="video-rallies-grid">
            {rallies.map((rally, index) => (
              <article className="video-rally-card" key={rally.blob_name || rally.number || index}>
                <div className="video-rally-title-row">
                  <h4>Rally {rally.number || index + 1}</h4>
                  {rally.duration_sec && <span>{Number(rally.duration_sec).toFixed(1)}s</span>}
                </div>
                <RallyVideoCard
                  rally={rally}
                  taskId={taskId}
                  onArtifactError={onArtifactError}
                  playerNames={playerNames}
                  annotationsEnabled={annotationsEnabled}
                  cleanMatch={trimmed}
                />
                <div className="video-rally-stats">
                  {rally.serving_player && (
                    <span className="video-rally-serve-label">
                      {rally.serving_player === 'P1' ? playerNames.p1 : playerNames.p2} serves
                    </span>
                  )}
                  <div className="video-rally-shot-counts">
                    <span className="video-rally-shot-counts-player">
                      {playerNames.p1}: {rally.p1_forehands ?? 0} FH · {rally.p1_backhands ?? 0} BH
                    </span>
                    <span className="video-rally-shot-counts-player">
                      {playerNames.p2}: {rally.p2_forehands ?? 0} FH · {rally.p2_backhands ?? 0} BH
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {winnerClips.length > 0 && (
        <section className="video-result-section">
          <div className="video-result-heading">
            <div>
              <span className="video-result-eyebrow">Winning shots</span>
              <h3>Winner Clips</h3>
            </div>
            <span className="video-rally-count">
              {winnerClips.length} {winnerClips.length === 1 ? 'winner' : 'winners'}
            </span>
          </div>
          <div className="video-winner-groups">
            {winnerGroups.filter((group) => group.clips.length > 0).map((group) => (
              <div className="video-winner-group" key={group.type}>
                <div className="video-winner-group-heading">
                  <h4>{group.title}</h4>
                  <span>{group.clips.length}</span>
                </div>
                <div className="video-rallies-grid">
                  {group.clips.map((winner, index) => (
                    <article
                      className="video-rally-card"
                      key={winner.blob_name || `${group.type}-${winner.rally_number}-${index}`}
                    >
                      <div className="video-rally-title-row">
                        <h4>{winner.player_label || 'Player'} · Rally {winner.rally_number}</h4>
                        {winner.duration_sec && <span>{Number(winner.duration_sec).toFixed(1)}s</span>}
                      </div>
                      <ResilientVideo
                        artifact={winner}
                        className="video-result-player"
                        onArtifactError={onArtifactError}
                      />
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function AnalysisWorkspace({ job, onDismiss, onDelete, deleting, deleteError, onArtifactError }) {
  if (!job) return null
  const complete = job.state === 'SUCCESS'
  const failed = job.state === 'FAILURE'
  const analysis = complete ? job.result : { trimmed_video: job.trimmed_video, rallies: [] }
  const progress = complete ? 100 : Math.max(0, Math.min(100, Number(job.progress) || 0))

  return (
    <div className={`video-analysis-workspace ${failed ? 'video-analysis-workspace--error' : ''}`}>
      <div className="video-analysis-workspace-header">
        <div>
          <span className="video-result-eyebrow">{job.standalone ? 'Standalone video analysis' : 'Match analysis'}</span>
          <h2>{complete
            ? (job.standalone ? 'Your video analysis is ready' : 'Your match is ready')
            : failed
            ? 'Analysis stopped'
            : job.standalone
            ? 'Analyzing your video'
            : `Analyzing ${job.opponent_name ? `vs ${job.opponent_name}` : 'your match'}`}</h2>
          <p>{failed ? (job.error || 'The analysis could not be completed.') : (job.message || 'Preparing your video…')}</p>
        </div>
        <div className="video-analysis-workspace-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>
            {complete || failed ? 'Close' : 'Hide'}
          </button>
          {(complete || failed) && (
            <button
              type="button"
              className="btn video-analysis-delete-btn btn-sm"
              onClick={onDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      {deleteError && <p className="video-upload-error">{deleteError}</p>}

      {job.connection_notice && (
        <div className="video-analysis-connection-notice" role="status">
          <strong>Cloud connection paused.</strong>
          <span>{job.connection_notice}</span>
        </div>
      )}

      {!failed && !complete && (
        <div className="video-analysis-progress" aria-label={`Analysis ${progress}% complete`}>
          <div className="video-analysis-progress-meta">
            <span>{(job.stage || 'queued').replaceAll('_', ' ')}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="video-analysis-progress-track">
            <div className="video-analysis-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          {job.rally_count !== undefined && (
            <span className="video-analysis-progress-detail">
              {job.rallies_complete || 0} of {job.rally_count} rallies prepared
            </span>
          )}
        </div>
      )}

      <AnalysisVideos analysis={analysis} taskId={job.task_id} onArtifactError={onArtifactError} />
    </div>
  )
}

function AnalysisJobMonitor({ job, onUpdate, onDismiss, onCompleted }) {
  const jobRef = useRef(job)
  const checkedTerminalStateRef = useRef(false)
  const recoveryRequestedRef = useRef(false)
  const lastRecoveryRequestRef = useRef(0)
  const [recoveryVersion, setRecoveryVersion] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const resultExpiry = artifactExpiryKey(job?.result)

  const requestArtifactRecovery = () => {
    const now = Date.now()
    if (now - lastRecoveryRequestRef.current < 5000) return
    lastRecoveryRequestRef.current = now
    recoveryRequestedRef.current = true
    setRecoveryVersion((version) => version + 1)
  }

  const deleteAnalysis = async () => {
    const opponent = job.opponent_name || 'this opponent'
    if (!window.confirm(`Permanently delete the video analysis for ${opponent}? This cannot be undone.`)) return
    setDeleting(true)
    setDeleteError('')
    try {
      await api.delete(`/video/analysis/${job.task_id}`)
      onDismiss(job.task_id)
    } catch (error) {
      setDeleteError(error.response?.data?.error || 'Could not delete this video analysis.')
      setDeleting(false)
    }
  }

  useEffect(() => {
    jobRef.current = job
  }, [job])

  useEffect(() => {
    const taskId = job?.task_id
    if (!taskId) return undefined
    const forceArtifactRefresh = recoveryRequestedRef.current
    recoveryRequestedRef.current = false
    // A cloud task can be retried server-side with the same MatchGenie task ID.
    // Recheck a locally cached FAILURE once on page load so the browser can
    // discover the replacement Batch job and its newly available artifacts.
    if (job.state === 'FAILURE' && checkedTerminalStateRef.current) return undefined
    if (job.state === 'FAILURE') checkedTerminalStateRef.current = true
    let cancelled = false
    let timer

    const poll = async () => {
      try {
        const res = await api.get(`/video/status/${taskId}`)
        if (cancelled) return
        const current = jobRef.current
        const next = { ...current, ...res.data, connection_notice: '' }
        if (
          current?.trimmed_video?.blob_name &&
          current.trimmed_video.blob_name === res.data.trimmed_video?.blob_name &&
          hasFreshArtifactUrl(current.trimmed_video) &&
          !forceArtifactRefresh
        ) {
          next.trimmed_video = current.trimmed_video
        }
        onUpdate(taskId, next)
        if (res.data.state === 'SUCCESS') {
          if (current?.state !== 'SUCCESS') onCompleted(taskId)
          return
        }
        if (res.data.state !== 'FAILURE') timer = window.setTimeout(poll, 2500)
      } catch (e) {
        if (!cancelled) {
          const response = e.response?.data || {}
          const authExpired = response.code === 'AWS_AUTH_EXPIRED'
          onUpdate(taskId, {
            ...jobRef.current,
            // Do not overwrite progress, stage, result, or artifact URLs. The
            // AWS Batch job continues even when localhost's SSO session lapses.
            connection_notice: response.error || 'Temporarily unable to refresh cloud progress. Retrying automatically…',
          })
          timer = window.setTimeout(poll, authExpired ? 15000 : 5000)
        }
      }
    }

    if (job.state === 'SUCCESS') {
      // History recovery intentionally returns completed jobs without their
      // signed media payload. Keep the full accordion list fast, then load and
      // sign only the analysis the user opens.
      if (!job.result && !expanded) return undefined
      // Completed AWS jobs remain visible above the saved match card. Their
      // S3 URLs expire, so renew them too instead of permanently freezing the
      // result at the first successful status response.
      const trimmed = job.result?.trimmed_video
      const delay = forceArtifactRefresh
        ? 0
        : hasFreshArtifactUrl(trimmed)
        ? artifactRefreshDelay(job.result)
        : 0
      timer = window.setTimeout(poll, delay)
    } else {
      poll()
    }
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [job?.task_id, job?.state, resultExpiry, recoveryVersion, expanded])

  return (
    <div className="video-analysis-accordion-item">
      <VideoAnalysisAccordionHeader
        opponent={job.opponent_name}
        date={job.match_date || job.analysis_date || (job.submitted_at ? job.submitted_at * 1000 : null)}
        expanded={expanded}
        status={job.state === "SUCCESS" ? "Ready" : job.state === "FAILURE" ? "Stopped" : "Analyzing"}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && (
        <div className="video-analysis-accordion-content">
          <AnalysisWorkspace
            job={job}
            onDismiss={() => onDismiss(job.task_id)}
            onDelete={deleteAnalysis}
            deleting={deleting}
            deleteError={deleteError}
            onArtifactError={requestArtifactRecovery}
          />
        </div>
      )}
    </div>
  )
}

function SavedAnalysis({ manifestRef }) {
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState('')
  const loadAnalysisRef = useRef(null)
  const lastRecoveryRequestRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let refreshTimer
    let loadedOnce = false
    setAnalysis(null)
    setError('')

    const loadAnalysis = () => {
      window.clearTimeout(refreshTimer)
      api.get('/video/analysis', { params: { blob_name: manifestRef } })
        .then((res) => {
          if (cancelled) return
          loadedOnce = true
          setAnalysis(res.data)
          setError('')
          refreshTimer = window.setTimeout(loadAnalysis, artifactRefreshDelay(res.data))
        })
        .catch((e) => {
          if (cancelled) return
          // Keep already-loaded videos on screen during a temporary AWS/SSO
          // failure, and keep retrying instead of replacing them with an error.
          if (!loadedOnce) {
            const response = e.response?.data || {}
            setError(response.retryable
              ? 'Cloud access is reconnecting. Your analyzed videos are safe and will appear automatically.'
              : (response.error || 'Could not load analyzed videos.'))
          }
          refreshTimer = window.setTimeout(loadAnalysis, 30 * 1000)
        })
    }

    loadAnalysisRef.current = loadAnalysis
    loadAnalysis()
    return () => {
      cancelled = true
      loadAnalysisRef.current = null
      window.clearTimeout(refreshTimer)
    }
  }, [manifestRef])

  const requestArtifactRecovery = () => {
    const now = Date.now()
    if (now - lastRecoveryRequestRef.current < 5000) return
    lastRecoveryRequestRef.current = now
    loadAnalysisRef.current?.()
  }

  // Extract task_id from the manifest path: jobs/{username}/{task_id}/manifest.json
  const taskId = useMemo(() => {
    if (!manifestRef) return null
    const match = manifestRef.match(/jobs\/[^/]+\/([^/]+)\/manifest/)
    return match ? match[1] : null
  }, [manifestRef])

  if (error) return <p className="video-upload-error">{error}</p>
  if (!analysis) return <div className="video-saved-loading"><div className="video-analyzing-spinner" /> Loading analyzed videos…</div>
  return <AnalysisVideos analysis={analysis} taskId={taskId} onArtifactError={requestArtifactRecovery} />
}

// ── Step 1: Video upload dropzone ─────────────────────────────────────────────

export function UploadStep({
  file, onFile, opponentName, onOpponentName,
  startTime, endTime, onTimeRange,
  sourceType, onSourceType, youtubeUrl, onYoutubeUrl,
  youtubeAuthorized, onYoutubeAuthorized,
  showRangeControls = true,
}) {
  const [dragging, setDragging] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const inputRef = useRef(null)
  const videoRef = useRef(null)

  useEffect(() => {
    if (!file) {
      setPreviewUrl('')
      setDuration(0)
      setCurrentTime(0)
      return undefined
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    setDuration(0)
    setCurrentTime(0)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const selectedEnd = Number.isFinite(endTime) ? endTime : duration
  const seekTo = (seconds) => {
    const next = Math.max(0, Math.min(duration, Number(seconds) || 0))
    if (videoRef.current) videoRef.current.currentTime = next
    setCurrentTime(next)
  }

  const setStart = (seconds) => {
    const next = Math.max(0, Math.min(Number(seconds) || 0, selectedEnd - 0.1))
    onTimeRange(next, selectedEnd)
    seekTo(next)
  }

  const setEnd = (seconds) => {
    const next = Math.min(duration, Math.max(Number(seconds) || 0, startTime + 0.1))
    onTimeRange(startTime, next)
    seekTo(next)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped && dropped.type.startsWith('video/')) onFile(dropped)
  }

  const ytId = youtubeVideoId(youtubeUrl)

  return (
    <div className="vp-upload-step">
      <div className="vp-source-tabs" role="tablist" aria-label="Video source">
        <button type="button" className={sourceType === 'file' ? 'active' : ''} onClick={() => onSourceType('file')}>Upload a file</button>
        <button type="button" className={sourceType === 'youtube' ? 'active' : ''} onClick={() => onSourceType('youtube')}>Use a YouTube link</button>
      </div>

      {sourceType === 'file' ? (
        <div
          className={`vp-dropzone ${dragging ? 'vp-dropzone--drag' : ''} ${file ? 'vp-dropzone--has-file' : ''}`}
          onClick={() => !file && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={(e) => onFile(e.target.files[0] || null)}
          />
          {file ? (
            <>
              <svg className="vp-dropzone-icon vp-dropzone-icon--ok" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span className="vp-dropzone-filename">{file.name}</span>
              <button
                className="btn btn-outline btn-sm"
                style={{ marginTop: '0.25rem' }}
                onClick={(e) => { e.stopPropagation(); onFile(null); inputRef.current.value = '' }}
              >
                Change file
              </button>
            </>
          ) : (
            <>
              <svg className="vp-dropzone-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span className="vp-dropzone-label">Drop your match video here</span>
              <span className="vp-dropzone-hint">or click to browse</span>
            </>
          )}
        </div>
      ) : (
        <div className="vp-youtube-source">
          <label className="vp-field-label" htmlFor="youtube-video-url">YouTube video link</label>
          <input
            id="youtube-video-url"
            className="form-input"
            type="url"
            inputMode="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={youtubeUrl}
            onChange={(e) => onYoutubeUrl(e.target.value)}
          />
          {youtubeUrl && !ytId && <p className="video-upload-error">Enter a link to one YouTube video.</p>}
          {ytId && (
            <iframe
              className="vp-youtube-preview"
              src={`https://www.youtube-nocookie.com/embed/${ytId}`}
              title="YouTube video preview"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          )}
          {showRangeControls && (
            <div className="vp-youtube-range">
              <div>
                <label className="vp-field-label" htmlFor="youtube-start-time">Start time</label>
                <TimecodeInput
                  id="youtube-start-time"
                  value={startTime}
                  placeholder="0:00"
                  onChange={(seconds) => onTimeRange(seconds, endTime)}
                />
              </div>
              <div>
                <label className="vp-field-label" htmlFor="youtube-end-time">End time (optional)</label>
                <TimecodeInput
                  id="youtube-end-time"
                  value={endTime}
                  optional
                  placeholder="End of video"
                  onChange={(seconds) => onTimeRange(startTime, seconds)}
                />
              </div>
            </div>
          )}
          <label className="vp-youtube-authorization">
            <input type="checkbox" checked={youtubeAuthorized} onChange={(e) => onYoutubeAuthorized(e.target.checked)} />
            <span>I own this video or have permission to download and analyze it.</span>
          </label>
          <span className="vp-field-hint">The AWS worker imports YouTube's highest available video and audio streams. YouTube has already re-encoded the original upload.</span>
        </div>
      )}

      {showRangeControls && sourceType === 'file' && file && previewUrl && (
        <div className="vp-range-picker">
          <div className="vp-range-picker-heading">
            <div>
              <span className="video-result-eyebrow">Analysis range</span>
              <h3>Choose where analysis starts and ends</h3>
            </div>
            <span className="vp-playhead-time">Playhead {formatVideoTime(currentTime)}</span>
          </div>

          <video
            ref={videoRef}
            className="vp-preview-video"
            controls
            preload="metadata"
            src={previewUrl}
            onLoadedMetadata={(e) => {
              const videoDuration = Number(e.currentTarget.duration) || 0
              setDuration(videoDuration)
              const nextEnd = Number.isFinite(endTime) && endTime > 0
                ? Math.min(endTime, videoDuration)
                : videoDuration
              const nextStart = Math.min(
                Math.max(0, Number(startTime) || 0),
                Math.max(0, nextEnd - 0.1),
              )
              onTimeRange(nextStart, nextEnd)
            }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          >
            Your browser does not support video playback.
          </video>

          <div className="vp-range-set-buttons">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!duration} onClick={() => setStart(currentTime)}>
              Set start here
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!duration} onClick={() => setEnd(currentTime)}>
              Set end here
            </button>
          </div>

          <div className="vp-range-control">
            <div className="vp-range-label-row">
              <label>Start</label>
              <strong>{formatVideoTime(startTime)}</strong>
            </div>
            <input
              type="range"
              min="0"
              max={Math.max(0, selectedEnd - 0.1)}
              step="0.1"
              value={Math.min(startTime, Math.max(0, selectedEnd - 0.1))}
              disabled={!duration}
              onChange={(e) => setStart(Number(e.target.value))}
            />
          </div>

          <div className="vp-range-control">
            <div className="vp-range-label-row">
              <label>End</label>
              <strong>{formatVideoTime(selectedEnd)}</strong>
            </div>
            <input
              type="range"
              min={Math.min(duration, startTime + 0.1)}
              max={duration || 0}
              step="0.1"
              value={selectedEnd || 0}
              disabled={!duration}
              onChange={(e) => setEnd(Number(e.target.value))}
            />
          </div>

          <div className="vp-selected-range-summary">
            Analyze {formatVideoTime(startTime)} – {formatVideoTime(selectedEnd)}
            <span>{formatVideoTime(Math.max(0, selectedEnd - startTime))} selected</span>
          </div>
        </div>
      )}

      {onOpponentName !== undefined && (
        <div style={{ marginTop: '1.25rem' }}>
          <label className="vp-field-label">Opponent's name (optional)</label>
          <input
            className="form-input"
            type="text"
            placeholder="e.g. John Smith"
            value={opponentName}
            onChange={(e) => onOpponentName(e.target.value)}
            style={{ marginTop: '0.4rem' }}
          />
        </div>
      )}

    </div>
  )
}

// ── Step 2: Player & opponent traits ──────────────────────────────────────────

const TRAITS = [
  { key: 'playerLefty',   label: 'Left-handed',         who: 'You' },
  { key: 'playerOneHand', label: '1-handed backhand',   who: 'You' },
  { key: 'oppLefty',      label: 'Left-handed',         who: 'Opponent' },
  { key: 'oppOneHand',    label: '1-handed backhand',   who: 'Opponent' },
]

function TraitsStep({ traits, onToggle }) {
  return (
    <div className="vp-traits-step">
      <p className="vp-step-hint">Select all that apply — leave blank if neither applies.</p>
      <div className="vp-traits-grid">
        {TRAITS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`vp-trait-card ${traits[t.key] ? 'vp-trait-card--on' : ''}`}
            onClick={() => onToggle(t.key)}
          >
            <span className="vp-trait-who">{t.who}</span>
            <span className="vp-trait-label">{t.label}</span>
            <span className="vp-trait-check">{traits[t.key] ? '✓' : ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Step 3: Court side picker ─────────────────────────────────────────────────

function CourtSideStep({ side, onSide }) {
  return (
    <div className="vp-court-step">
      <p className="vp-step-hint">
        Looking at the first point of the video, which half of the court do you start on?
      </p>
      <div className="vp-court-picker">
        <button
          type="button"
          className={`vp-court-card ${side === 'near' ? 'vp-court-card--on' : ''}`}
          onClick={() => onSide('near')}
        >
          <CourtDiagram highlight="near" />
          <span className="vp-court-card-label">Near side</span>
          <span className="vp-court-card-sub">Closer to the camera</span>
        </button>
        <button
          type="button"
          className={`vp-court-card ${side === 'far' ? 'vp-court-card--on' : ''}`}
          onClick={() => onSide('far')}
        >
          <CourtDiagram highlight="far" />
          <span className="vp-court-card-label">Far side</span>
          <span className="vp-court-card-sub">Further from the camera</span>
        </button>
      </div>
    </div>
  )
}

function CourtDiagram({ highlight }) {
  const nearFill = highlight === 'near' ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.04)'
  const farFill  = highlight === 'far'  ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.04)'
  const nearStroke = highlight === 'near' ? '#22c55e' : 'rgba(255,255,255,0.2)'
  const farStroke  = highlight === 'far'  ? '#22c55e' : 'rgba(255,255,255,0.2)'
  return (
    <svg width="96" height="72" viewBox="0 0 96 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Court outline */}
      <rect x="8" y="4" width="80" height="64" rx="2" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5"/>
      {/* Net */}
      <line x1="8" y1="36" x2="88" y2="36" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeDasharray="3 2"/>
      {/* Near half (bottom) */}
      <rect x="8" y="36" width="80" height="32" rx="0" fill={nearFill} stroke={nearStroke} strokeWidth="1"/>
      {/* Far half (top) */}
      <rect x="8" y="4" width="80" height="32" rx="0" fill={farFill} stroke={farStroke} strokeWidth="1"/>
      {/* Service boxes */}
      <line x1="48" y1="4" x2="48" y2="36" stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
      <line x1="48" y1="36" x2="48" y2="68" stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
      {/* Camera icon at bottom */}
      <rect x="40" y="62" width="16" height="8" rx="1.5" fill="rgba(255,255,255,0.4)"/>
      <circle cx="48" cy="66" r="2.5" fill="rgba(255,255,255,0.6)"/>
      <text x="48" y="29" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="sans-serif">FAR</text>
      <text x="48" y="56" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="sans-serif">NEAR</text>
    </svg>
  )
}

// ── Shared pipeline state builder ─────────────────────────────────────────────

const INITIAL_PIPELINE = () => ({
  file: null,
  sourceType: 'file',
  youtubeUrl: '',
  youtubeAuthorized: false,
  opponentName: '',
  startTime: 0,
  endTime: null,
  traits: { playerLefty: false, playerOneHand: false, oppLefty: false, oppOneHand: false },
  side: '',
})

function buildFormData(state, extra = {}) {
  const fd = new FormData()
  if (!extra.use_existing_video) {
    if (state.sourceType === 'youtube') {
      fd.append('youtube_url', state.youtubeUrl.trim())
      fd.append('youtube_authorized', state.youtubeAuthorized ? 'true' : 'false')
    } else {
      fd.append('video', state.file)
    }
  }
  fd.append('opponent_name', state.opponentName.trim() || 'Opponent')
  fd.append('player_side', state.side)
  fd.append('start_time', String(state.startTime || 0))
  fd.append('end_time', state.endTime == null ? '' : String(state.endTime))
  fd.append('player_left_handed', state.traits.playerLefty ? 'true' : 'false')
  fd.append('player_one_handed_backhand', state.traits.playerOneHand ? 'true' : 'false')
  fd.append('opp_left_handed', state.traits.oppLefty ? 'true' : 'false')
  fd.append('opp_one_handed_backhand', state.traits.oppOneHand ? 'true' : 'false')
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  return fd
}

function analysisUploadError(error) {
  const serverMessage = error.response?.data?.error
  if (serverMessage) return serverMessage
  const status = error.response?.status
  if (status === 502 || status === 504) {
    return 'The upload gateway timed out while copying this large video to cloud storage. Please retry the upload.'
  }
  if (error.code === 'ERR_NETWORK') {
    return 'The connection was interrupted during upload. Check that the local backend is running, then retry.'
  }
  return 'Upload failed. Please try again.'
}

const STEP_TITLES = ['Choose Video', 'Player Details', 'Court Position']

// ── Inline upload panel (inside a match card) ─────────────────────────────────

export function InlineUploadPanel({ rowIndex, opponentName = '', existingVideo = false, onUploaded, onCancel }) {
  const [step, setStep] = useState(existingVideo ? 2 : 1)
  const [state, setState] = useState(() => ({ ...INITIAL_PIPELINE(), opponentName }))
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setState((prev) => ({ ...prev, ...patch }))

  const handleUpload = async () => {
    if (!existingVideo && !sourceIsReady(state)) {
      setError(state.sourceType === 'youtube'
        ? 'Enter one YouTube video link, confirm permission, and check the optional time range.'
        : 'Choose an end point after the analysis start point.')
      return
    }
    setUploading(true)
    setError('')
    try {
      const fd = buildFormData(state, {
        row_index: rowIndex,
        ...(existingVideo ? { use_existing_video: 'true' } : {}),
      })
      const res = await api.post('/video/analyze', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      onUploaded(res.data)
    } catch (e) {
      setError(analysisUploadError(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="video-inline-upload">
      <div className="vp-step-tabs">
        {STEP_TITLES.map((title, i) => (
          <span key={i} className={`vp-step-tab ${step === i + 1 ? 'vp-step-tab--active' : step > i + 1 ? 'vp-step-tab--done' : ''}`}>
            {step > i + 1 ? '✓' : i + 1}. {existingVideo && i === 0 ? 'Saved Video' : title}
          </span>
        ))}
      </div>

      {step === 1 && (
        <>
          <UploadStep
            file={state.file}
            onFile={(f) => set({ file: f, startTime: 0, endTime: null })}
            sourceType={state.sourceType}
            onSourceType={(sourceType) => set({ sourceType, file: null, youtubeUrl: '', youtubeAuthorized: false, startTime: 0, endTime: null })}
            youtubeUrl={state.youtubeUrl}
            onYoutubeUrl={(youtubeUrl) => set({ youtubeUrl })}
            youtubeAuthorized={state.youtubeAuthorized}
            onYoutubeAuthorized={(youtubeAuthorized) => set({ youtubeAuthorized })}
            startTime={state.startTime}
            endTime={state.endTime}
            onTimeRange={(start, end) => set({ startTime: start, endTime: end })}
          />
          <div className="video-inline-upload-actions">
            <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={!sourceIsReady(state)} onClick={() => setStep(2)}>
              Next →
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <TraitsStep
            traits={state.traits}
            onToggle={(key) => set({ traits: { ...state.traits, [key]: !state.traits[key] } })}
          />
          <div className="video-inline-upload-actions">
            <button className="btn btn-secondary btn-sm" onClick={existingVideo ? onCancel : () => setStep(1)}>
              {existingVideo ? 'Cancel' : '← Back'}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setStep(3)}>Next →</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <CourtSideStep side={state.side} onSide={(s) => set({ side: s })} />
          {error && <p className="video-upload-error">{error}</p>}
          <div className="video-inline-upload-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setStep(2)}>← Back</button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!state.side || uploading}
              onClick={handleUpload}
            >
              {uploading ? 'Starting…' : existingVideo ? 'Analyze Saved Video' : 'Upload & Analyze'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function MatchVideoUploadModal({ match, onClose, onStarted }) {
  const rowIndex = match?.['_row_index']
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box vp-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        <h2 className="modal-title">Upload Video for Analysis</h2>
        <p className="modal-subtitle" style={{ marginBottom: '1.25rem' }}>
          {match ? `Match vs ${match['Opp. Name'] || 'Unknown'} on ${formatDate(match['Match Date'])}` : ''}
        </p>
        <InlineUploadPanel
          rowIndex={rowIndex}
          opponentName={match?.['Opp. Name'] || ''}
          existingVideo={Boolean(match?.['Match Video'])}
          onUploaded={(task) => {
            onStarted?.(task)
            onClose()
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}

function MatchSelectionModal({ matches, onClose, onStarted }) {
  const [selectedMatch, setSelectedMatch] = useState(null)
  const [standaloneUpload, setStandaloneUpload] = useState(false)
  const [availableMatches, setAvailableMatches] = useState(matches)
  const [matchesLoading, setMatchesLoading] = useState(matches.length === 0)
  const [matchesError, setMatchesError] = useState('')
  const unanalyzedMatches = availableMatches.filter(
    (match) => !String(match['Analyzed Video Link'] || '').trim()
  )

  const refreshMatches = () => {
    setMatchesLoading(true)
    setMatchesError('')
    return api.get('/matches')
      .then((res) => setAvailableMatches(res.data.matches || []))
      .catch((error) => setMatchesError(error.response?.data?.error || 'Unable to load matches.'))
      .finally(() => setMatchesLoading(false))
  }

  useEffect(() => {
    if (matches.length) {
      setAvailableMatches(matches)
      setMatchesLoading(false)
      setMatchesError('')
      return
    }
    refreshMatches()
  }, [matches])

  if (standaloneUpload) {
    return <NewVideoModal onClose={onClose} onStarted={onStarted} />
  }

  if (selectedMatch) {
    return <MatchVideoUploadModal match={selectedMatch} onClose={onClose} onStarted={onStarted} />
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box vp-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        <h2 className="modal-title">Choose a Match</h2>
        <p className="modal-subtitle">Upload a new video or select an existing match for video analysis.</p>
        <button
          type="button"
          className="video-standalone-upload"
          onClick={() => setStandaloneUpload(true)}
        >
          <span className="video-standalone-upload-icon">＋</span>
          <span>
            <strong>Upload New Video</strong>
          </span>
        </button>
        <div className="video-match-picker">
          {matchesLoading && (
            <div className="video-saved-loading">
              <div className="video-analyzing-spinner" /> Loading your matches…
            </div>
          )}
          {!matchesLoading && matchesError && (
            <div className="video-match-picker-error" role="alert">
              <span>{matchesError}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={refreshMatches}>Retry</button>
            </div>
          )}
          {!matchesLoading && !matchesError && unanalyzedMatches.length === 0 && (
            <p className="video-match-picker-empty">All logged matches have already been analyzed.</p>
          )}
          {!matchesLoading && !matchesError && unanalyzedMatches.map((match, index) => {
            const rowIndex = match['_row_index'] ?? index + 2
            return (
              <button
                key={rowIndex}
                type="button"
                className="video-match-picker-item"
                onClick={() => setSelectedMatch(match)}
              >
                <span>
                  <strong>vs {match['Opp. Name'] || 'Unknown'}</strong>
                  <small>{formatDate(match['Match Date'])}</small>
                </span>
                <span className="video-match-picker-status">Upload & Analyze</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── "Upload New Video" modal ───────────────────────────────────────────────────

function NewVideoModal({ onClose, onStarted }) {
  const [step, setStep] = useState(1)
  const [state, setState] = useState(INITIAL_PIPELINE())
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setState((prev) => ({ ...prev, ...patch }))

  const handleUpload = async () => {
    if (!sourceIsReady(state)) {
      setError(state.sourceType === 'youtube'
        ? 'Enter one YouTube video link, confirm permission, and check the optional time range.'
        : 'Choose an end point after the analysis start point.')
      return
    }
    setUploading(true)
    setError('')
    try {
      const fd = buildFormData(state)
      const res = await api.post('/video/analyze', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      onStarted(res.data)
      setDone(true)
      onClose()
    } catch (e) {
      setError(analysisUploadError(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box vp-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>

        {done ? (
          <div className="video-analyzing-banner" style={{ marginTop: '0.5rem' }}>
            <div className="video-analyzing-spinner" />
            <div>
              <div className="video-analyzing-title">Video uploaded!</div>
              <div className="video-analyzing-sub">Analysis started. Check back in a few minutes.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="vp-modal-header">
              <h2 className="modal-title">{STEP_TITLES[step - 1]}</h2>
              <div className="modal-step-indicator" style={{ marginBottom: 0 }}>
                {STEP_TITLES.map((_, i) => (
                  <div key={i} className={`modal-step-dot ${i + 1 === step ? 'active' : i + 1 < step ? 'done' : ''}`} />
                ))}
              </div>
            </div>

            {step === 1 && (
              <>
                <UploadStep
                  file={state.file}
                  onFile={(f) => set({ file: f, startTime: 0, endTime: null })}
                  sourceType={state.sourceType}
                  onSourceType={(sourceType) => set({ sourceType, file: null, youtubeUrl: '', youtubeAuthorized: false, startTime: 0, endTime: null })}
                  youtubeUrl={state.youtubeUrl}
                  onYoutubeUrl={(youtubeUrl) => set({ youtubeUrl })}
                  youtubeAuthorized={state.youtubeAuthorized}
                  onYoutubeAuthorized={(youtubeAuthorized) => set({ youtubeAuthorized })}
                  opponentName={state.opponentName}
                  onOpponentName={(v) => set({ opponentName: v })}
                  startTime={state.startTime}
                  endTime={state.endTime}
                  onTimeRange={(start, end) => set({ startTime: start, endTime: end })}
                />
                <div className="vp-modal-actions">
                  <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                  <button className="btn btn-primary" disabled={!sourceIsReady(state)} onClick={() => setStep(2)}>
                    Next →
                  </button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <TraitsStep
                  traits={state.traits}
                  onToggle={(key) => set({ traits: { ...state.traits, [key]: !state.traits[key] } })}
                />
                <div className="vp-modal-actions">
                  <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>
                  <button className="btn btn-primary" onClick={() => setStep(3)}>Next →</button>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <CourtSideStep side={state.side} onSide={(s) => set({ side: s })} />
                {error && <p className="video-upload-error" style={{ marginTop: '0.75rem' }}>{error}</p>}
                <div className="vp-modal-actions">
                  <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button>
                  <button
                    className="btn btn-primary"
                    disabled={!state.side || uploading}
                    onClick={handleUpload}
                  >
                    {uploading ? 'Uploading…' : 'Upload & Analyze'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function VideoHowItWorksModal({ onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box video-how-modal" role="dialog" aria-modal="true" aria-labelledby="video-how-title" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>×</button>
        <h2 className="modal-title" id="video-how-title">How MatchGenie Video Analysis Works</h2>
        <p className="video-how-beta">MatchGenie AI-Assisted Match Video Analysis <strong>(beta version—results may not always be accurate)</strong></p>

        <ol className="video-how-steps">
          <li>
            <strong>Add your match video</strong>
            <p>Upload a video directly or paste a publicly accessible YouTube link to footage you own or have permission to analyze.</p>
          </li>
          <li>
            <strong>Set up the analysis</strong>
            <p>Provide the start and end times, player names, each player’s handedness, and their starting court positions.</p>
          </li>
          <li>
            <strong>AI analysis pipeline</strong>
            <div className="video-how-pipeline">
              <div><strong>Trimmed video</strong><span>removes dead time</span></div><b>↓</b>
              <div><strong>Rally clips</strong><span>organizes the match into individual rallies</span></div><b>↓</b>
              <div><strong>Pose and player detection</strong><span>identifies players and analyzes their movement</span></div><b>↓</b>
              <div><strong>Court and ball detection</strong><span>identifies the court and tracks the ball</span></div><b>↓</b>
              <div><strong>Shot detection</strong><span>recognizes serves, forehands, and backhands</span></div>
            </div>
          </li>
          <li>
            <strong>Choose your viewing experience</strong>
            <p>Annotations are <strong>on by default</strong>, displaying pose, player, court, ball, and shot detections. Turn annotations off at any time for a clean view of the match.</p>
          </li>
          <li>
            <strong>Review and correct</strong>
            <p>Review the AI-detected shots and correct inaccurate labels. Your corrections provide feedback that helps improve future AI analysis.</p>
          </li>
          <li>
            <strong>Explore the shots and rallies from the match</strong>
            <p>View the completed analysis through the organized rally clips, shot and player information.</p>
          </li>
        </ol>

        <p className="video-how-footer">
          Follow the status in the progress tracker. You can close the page while processing continues and return later to view the completed analysis. A full match typically takes <strong>3–8 hours</strong> to process. Processing time varies depending on the video’s length, resolution, visibility, and current system demand. For best results, use stable footage from behind the baseline with the full court and both players clearly visible.
        </p>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Video() {
  const { user } = useAuth()
  const analysisOwnerKey = user?.id ?? user?.username ?? null
  const analysisJobsKey = analysisOwnerKey == null
    ? null
    : `${ANALYSIS_JOBS_KEY_PREFIX}${encodeURIComponent(String(analysisOwnerKey))}`
  const videoQuery = new URLSearchParams(window.location.search)
  const focusedRow = Number(videoQuery.get('match')) || null
  const shouldOpenAnalysisForm = videoQuery.get('analyze') === '1'
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [openUpload, setOpenUpload] = useState(null)
  const [locallyUploaded, setLocallyUploaded] = useState({})
  const [showNewVideoModal, setShowNewVideoModal] = useState(false)
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [visibleCount, setVisibleCount] = useState(3)
  const [expandedMatch, setExpandedMatch] = useState(null)
  const [analysisJobs, setAnalysisJobs] = useState(() => readStoredAnalyses(analysisJobsKey))
  const [analysisJobsOwnerKey, setAnalysisJobsOwnerKey] = useState(analysisJobsKey)

  useEffect(() => {
    setAnalysisJobs(readStoredAnalyses(analysisJobsKey))
    setAnalysisJobsOwnerKey(analysisJobsKey)
    // These older keys were shared by every account in the browser. They have
    // no trustworthy owner, so never attach their contents to a signed-in user.
    localStorage.removeItem(ANALYSIS_JOBS_KEY)
    localStorage.removeItem(LEGACY_ANALYSIS_JOB_KEY)
  }, [analysisJobsKey])

  const loadMatches = () => {
    setLoading(true)
    return api.get('/matches')
      .then((res) => setMatches(res.data.matches || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadMatches()
    let cancelled = false
    let restoreTimer
    const restoreActiveAnalyses = () => {
      api.get('/video/active-analyses')
        .then((res) => {
          if (cancelled) return
          const discovered = Array.isArray(res.data?.analyses) ? res.data.analyses : []
          if (!discovered.length) return
          setAnalysisJobs((current) => {
            const currentById = new Map(current.map((job) => [job.task_id, job]))
            const restored = discovered.map((job) => ({
              ...(currentById.get(job.task_id) || {}),
              ...job,
              connection_notice: '',
            }))
            const restoredIds = new Set(restored.map((job) => job.task_id))
            return [
              ...restored,
              ...current.filter((job) => !restoredIds.has(job.task_id)),
            ]
          })
        })
        .catch((e) => {
          if (!cancelled && e.response?.data?.retryable) {
            // A page refresh during an expired localhost SSO session must not
            // make an AWS job disappear forever. Discover it after re-login.
            restoreTimer = window.setTimeout(restoreActiveAnalyses, 15 * 1000)
          }
        })
    }
    restoreActiveAnalyses()
    return () => {
      cancelled = true
      window.clearTimeout(restoreTimer)
    }
  }, [analysisJobsKey])

  useEffect(() => {
    if (!focusedRow || !matches.length) return
    const focusedIndex = matches.findIndex((match, index) => (match['_row_index'] ?? index + 2) === focusedRow)
    if (focusedIndex < 0) return
    setVisibleCount((count) => Math.max(count, focusedIndex + 1))
    setExpandedMatch(focusedRow)
    if (shouldOpenAnalysisForm && !matches[focusedIndex]['Analyzed Video Link']) {
      setOpenUpload(focusedIndex)
    }
    window.setTimeout(() => {
      document.getElementById(`video-match-${focusedRow}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }, [focusedRow, shouldOpenAnalysisForm, matches])

  useEffect(() => {
    if (!analysisJobsKey || analysisJobsOwnerKey !== analysisJobsKey) return
    if (analysisJobs.length) localStorage.setItem(analysisJobsKey, JSON.stringify(analysisJobs))
    else localStorage.removeItem(analysisJobsKey)
  }, [analysisJobs, analysisJobsKey, analysisJobsOwnerKey])

  const beginAnalysis = (task) => {
    const job = {
      ...task,
      task_id: task.task_id,
      state: task.state || 'PENDING',
      progress: task.progress || 0,
      stage: task.stage || 'queued',
      message: task.message || 'Video uploaded. Analysis is queued.',
      analysis_date: task.analysis_date || new Date().toISOString(),
    }
    setAnalysisJobs((current) => [
      job,
      ...current.filter((item) => item.task_id !== job.task_id),
    ])
  }

  const updateAnalysis = (taskId, next) => {
    setAnalysisJobs((current) => current.map((job) => (
      job.task_id === taskId ? next : job
    )))
  }

  const dismissAnalysis = (taskId) => {
    setAnalysisJobs((current) => current.filter((job) => job.task_id !== taskId))
  }

  const completeAnalysis = () => {
    setLocallyUploaded({})
    loadMatches()
  }

  const getVideoStatus = (match, index) => {
    if (match['Analyzed Video Link']) return 'analyzed'
    if (locallyUploaded[index]) return 'analyzing'
    if (match['Match Video']) return 'analyzing'
    return 'none'
  }

  const analyzedMatchCount = matches.filter((match) => Boolean(match['Analyzed Video Link'])).length
  const standaloneAnalysisCount = new Set(
    analysisJobs
      .filter((job) => job.standalone && job.state !== 'FAILURE')
      .map((job) => job.task_id),
  ).size
  const videoAnalysisCount = analyzedMatchCount + standaloneAnalysisCount

  return (
    <div className="matches-page">
      <div className="matches-header">
        <div>
          <h1>Match Videos</h1>
          <p>{videoAnalysisCount} video {videoAnalysisCount === 1 ? 'analysis' : 'analyses'}</p>
        </div>
        <div className="video-header-actions">
          <button className="btn btn-secondary" type="button" onClick={() => setShowHowItWorks(true)}>
            How It Works
          </button>
          <button
            className="btn btn-primary video-new-upload-btn"
            onClick={() => setShowNewVideoModal(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Upload New Video for Analysis
          </button>
        </div>
      </div>

      {showHowItWorks && <VideoHowItWorksModal onClose={() => setShowHowItWorks(false)} />}

      {analysisJobs.length > 0 && (
        <div className="video-analysis-jobs">
          {analysisJobs.map((job) => {
            const linkedMatch = matches.find((match, index) => (
              (match['_row_index'] ?? index + 2) === job.row_index
            ))
            const displayJob = {
              ...job,
              opponent_name: job.opponent_name || linkedMatch?.['Opp. Name'],
              match_date: job.match_date || linkedMatch?.['Match Date'],
            }
            return (
              <AnalysisJobMonitor
                key={job.task_id}
                job={displayJob}
                onUpdate={updateAnalysis}
                onDismiss={dismissAnalysis}
                onCompleted={completeAnalysis}
              />
            )
          })}
        </div>
      )}

      {loading ? (
        <div className="loading">Loading matches…</div>
      ) : matches.length === 0 ? (
        <div className="matches-empty">
          <p>No matches logged yet. You can still upload a standalone video for AI analysis.</p>
        </div>
      ) : (
        <div className="matches-list">
          {matches.slice(0, visibleCount).map((match, i) => {
            const status = getVideoStatus(match, i)
            const rowIndex = match['_row_index'] ?? i + 2
            const isUploadOpen = openUpload === i
            const isExpanded = expandedMatch === rowIndex

            return (
              <div id={`video-match-${rowIndex}`} key={i} className="video-analysis-accordion-item">
                <VideoAnalysisAccordionHeader
                  opponent={match['Opp. Name'] || 'Unknown'}
                  date={match['Match Date']}
                  expanded={isExpanded}
                  status={status === 'analyzed' ? 'Ready' : status === 'analyzing' ? 'Analyzing' : 'No analysis'}
                  onToggle={() => setExpandedMatch(isExpanded ? null : rowIndex)}
                />
                {isExpanded && <div className="video-analysis-accordion-content">
                {status === 'none' && !isUploadOpen && (
                  <div className="match-card-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => setOpenUpload(i)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '0.3rem' }}>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      Upload Video
                    </button>
                  </div>
                )}

                {status !== 'analyzed' && isUploadOpen && (
                  <InlineUploadPanel
                    rowIndex={rowIndex}
                    opponentName={match['Opp. Name'] || ''}
                    existingVideo={Boolean(match['Match Video'])}
                    onUploaded={(task) => {
                      beginAnalysis({
                        ...task,
                        opponent_name: match['Opp. Name'] || 'Opponent',
                        match_date: match['Match Date'],
                      })
                      setLocallyUploaded((prev) => ({ ...prev, [i]: true }))
                      setOpenUpload(null)
                    }}
                    onCancel={() => setOpenUpload(null)}
                  />
                )}

                {status === 'analyzing' && !isUploadOpen && (
                  <div className="match-card-video-area">
                    <div className="video-analyzing-banner">
                      <div className="video-analyzing-spinner" />
                      <div>
                        <div className="video-analyzing-title">Your video is being analyzed</div>
                        <div className="video-analyzing-sub">This usually takes 5–15 minutes. Check back soon.</div>
                      </div>
                    </div>
                  </div>
                )}

                {status === 'analyzed' && (
                  <div className="match-card-video-area">
                    <SavedAnalysis manifestRef={match['Analyzed Video Link']} />
                  </div>
                )}
                </div>}
              </div>
            )
          })}

          {visibleCount < matches.length && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => setVisibleCount((c) => c + 3)}>
                View More
              </button>
            </div>
          )}
        </div>
      )}

      {showNewVideoModal && (
        <MatchSelectionModal
          matches={matches}
          onClose={() => setShowNewVideoModal(false)}
          onStarted={(task) => {
            beginAnalysis(task)
            loadMatches()
          }}
        />
      )}
    </div>
  )
}
