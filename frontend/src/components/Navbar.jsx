import { useState, useRef, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'
import logo from '../assets/matchgenie.png'

const ADMIN_USERNAMES = ['sid']

export default function Navbar() {
  const { user, logout, updateUser } = useAuth()
  const [showProfile, setShowProfile] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [location, setLocation] = useState('')
  const [utr, setUtr] = useState('')
  const [email, setEmail] = useState('')
  const [picFile, setPicFile] = useState(null)
  const [picPreview, setPicPreview] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [emailPrompt, setEmailPrompt] = useState(false)
  const dropdownRef = useRef(null)
  const emailInputRef = useRef(null)

  // Sync form fields when dropdown opens
  useEffect(() => {
    if (showProfile && user) {
      setFirstName(user.first_name || '')
      setLastName(user.last_name || '')
      setLocation(user.location || '')
      setUtr(user.utr || '')
      setEmail(user.email || (user.is_google_user ? user.username : '') || '')
      setPicFile(null)
      setPicPreview(null)
    }
    if (!showProfile) setEmailPrompt(false)
  }, [showProfile, user])

  // Close on outside click
  useEffect(() => {
    if (!showProfile) return
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowProfile(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showProfile])

  const handlePicChange = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setPicFile(file)
    setPicPreview(URL.createObjectURL(file))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError('')
    try {
      const fd = new FormData()
      fd.append('first_name', firstName)
      fd.append('last_name', lastName)
      fd.append('location', location)
      fd.append('utr', utr)
      fd.append('email', email)
      if (picFile) fd.append('profile_pic', picFile)

      const res = await api.put('/auth/profile', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      updateUser(res.data)
      setShowProfile(false)
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const displayName = user?.first_name || user?.username
  const profilePicUrl = picPreview || (user?.profile_pic ? `/api/auth/profile-pic/${user.profile_pic}` : null)
  const initial = (user?.first_name || user?.username || 'U').charAt(0).toUpperCase()
  const isAdmin = ADMIN_USERNAMES.includes(user?.username?.toLowerCase())

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <NavLink to="/">
          <img src={logo} alt="Match Genie" className="navbar-logo" />
        </NavLink>
      </div>
      <div className="navbar-links">
        <NavLink to="/track" className={({ isActive }) => `nav-link nav-track${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Track
        </NavLink>
        <NavLink to="/log" className={({ isActive }) => `nav-link nav-log${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          Log
        </NavLink>
        <NavLink to="/matches" className={({ isActive }) => `nav-link nav-matches${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          Matches
        </NavLink>
        <NavLink to="/stats" className={({ isActive }) => `nav-link nav-stats${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          Stats
        </NavLink>
        <NavLink to="/crush" className={({ isActive }) => `nav-link nav-crush${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
          Crush
        </NavLink>
        <NavLink to="/video" className={({ isActive }) => `nav-link nav-video${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          Video
        </NavLink>
        <NavLink to="/coach" className={({ isActive }) => `nav-link nav-coach${isActive ? ' active' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Coach
        </NavLink>
        {isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} style={{ fontSize: '0.75rem', opacity: 0.7 }}>
            Admin
          </NavLink>
        )}
      </div>
      <div className="navbar-user" ref={dropdownRef}>
        <a href="https://www.matchgenie.ai" target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">Home</a>
        <a href="https://www.matchgenie.ai/pricing" target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">Pricing</a>
        <a href="https://www.matchgenie.ai/about" target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">About</a>
        <button className="navbar-profile-btn" onClick={() => setShowProfile(!showProfile)}>
          {user?.profile_pic ? (
            <img src={`/api/auth/profile-pic/${user.profile_pic}`} alt="" className="profile-pic-navbar" />
          ) : (
            <span className="profile-pic-navbar profile-pic-initial">{initial}</span>
          )}
          <span className="navbar-username">{displayName}</span>
        </button>
        <button onClick={logout} className="btn btn-outline btn-sm">Logout</button>

        {showProfile && (
          <div className="profile-dropdown">
            <div className="profile-pic-upload" onClick={() => document.getElementById('profile-pic-input').click()}>
              {profilePicUrl ? (
                <img src={profilePicUrl} alt="" />
              ) : (
                <span className="profile-pic-initial-lg">{initial}</span>
              )}
              <div className="profile-pic-overlay">Change</div>
              <input id="profile-pic-input" type="file" accept="image/*" onChange={handlePicChange} style={{ display: 'none' }} />
            </div>
            <div className="profile-form-group">
              <label>First Name</label>
              <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First Name" />
            </div>
            <div className="profile-form-group">
              <label>Last Name</label>
              <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last Name" />
            </div>
            <div className="profile-form-group">
              <label>Location</label>
              <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, State" />
            </div>
            <div className="profile-form-group">
              <label>UTR</label>
              <input type="text" value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. 8.5" />
            </div>
            <div className="profile-form-group">
              <label>Email Address</label>
              <input
                ref={emailInputRef}
                type="email"
                value={email}
                onChange={(e) => { if (!user?.is_google_user) { setEmail(e.target.value); setEmailPrompt(false) } }}
                placeholder="your@email.com"
                readOnly={!!user?.is_google_user}
                style={{
                  ...(emailPrompt ? { borderColor: '#f59e0b', boxShadow: '0 0 0 2px rgba(245,158,11,0.25)' } : {}),
                  ...(user?.is_google_user ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
                }}
              />
              {user?.is_google_user && (
                <p style={{ color: 'var(--muted-text)', fontSize: '0.78rem', marginTop: '0.35rem' }}>
                  Email is managed by your Google account.
                </p>
              )}
              {emailPrompt && !user?.is_google_user && (
                <p style={{ color: '#f59e0b', fontSize: '0.78rem', marginTop: '0.35rem' }}>
                  Please enter your email to upgrade your plan.
                </p>
              )}
            </div>
            {saveError && (
              <p style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{saveError}</p>
            )}
            <div className="profile-dropdown-actions">
              <button className="btn btn-outline btn-sm" onClick={() => setShowProfile(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  )
}
