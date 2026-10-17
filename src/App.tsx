import React, { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { FeatureFlagProvider, useFeatureFlag } from './lib/featureFlags.js'
import { WalletProvider } from './contexts/WalletContext.js'
import LanguageSwitcher from './components/LanguageSwitcher'
import ProvenanceBadge from './components/ProvenanceBadge.jsx'

function AppContent() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [visibleElements, setVisibleElements] = useState<Set<number>>(new Set())

  // Subsystem 3 Feature Flag Hook Evaluators
  const emergencyBroadcasterEnabled = useFeatureFlag('emergency_broadcaster')
  const sorobanBackupEnabled = useFeatureFlag('soroban_state_backup')
  const canaryMapClustering = useFeatureFlag('canary_map_clustering')

  useEffect(() => {
    const elements = document.querySelectorAll('[data-reveal]')
    const vh = window.innerHeight || 800

    elements.forEach((el, idx) => {
      const rect = el.getBoundingClientRect()
      if (rect.top <= vh * 0.85) {
        setVisibleElements((prev) => new Set([...prev, idx]))
      }
    })

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const idx = Array.from(elements).indexOf(entry.target)
            setVisibleElements((prev) => new Set([...prev, idx]))
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -7% 0px' }
    )

    elements.forEach((el) => observer.observe(el))

    const timeout = setTimeout(() => {
      setVisibleElements((prev) => new Set(Array.from({ length: elements.length }, (_, i) => i)))
    }, 4500)

    return () => {
      observer.disconnect()
      clearTimeout(timeout)
    }
  }, [])

  return (
    <div style={{ background: '#1c2c24', color: '#ECE0CC', minHeight: '100vh' }}>
      {/* Header Navigation — `hp-app-nav-*` rules in App.css keep the bar
          usable at phone widths (verified by tests/e2e/layout.spec.ts). */}
      <nav
        className="hp-app-nav"
        style={{
          position: 'fixed',
          top: 0,
          insetInline: 0,
          zIndex: 100,
          background: 'rgba(28, 44, 36, 0.92)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div className="hp-app-nav-brand" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#FF7A6B' }}>HelPhone</span>
          {canaryMapClustering && (
            <span
              className="hp-app-nav-status"
              style={{
                fontSize: '0.75rem',
                background: '#7357FF',
                color: '#fff',
                padding: '0.2rem 0.5rem',
                borderRadius: '999px',
                fontWeight: 600,
              }}
            >
              CANARY ACTIVE
            </span>
          )}
        </div>

        <div
          className="hp-app-nav-links"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}
        >
          <Link to="/" style={{ color: '#ECE0CC', textDecoration: 'none' }}>
            Home
          </Link>
          <Link to="/help" style={{ color: '#ECE0CC', textDecoration: 'none' }}>
            Emergency Request
          </Link>
          <Link to="/ranking" style={{ color: '#ECE0CC', textDecoration: 'none' }}>
            Responders
          </Link>
          {sorobanBackupEnabled && (
            <span className="hp-app-nav-status" style={{ fontSize: '0.8rem', color: '#3F8487' }}>
              🛡️ State Backup Active
            </span>
          )}
          <ProvenanceBadge />
          <LanguageSwitcher />
        </div>
      </nav>

      {/* Hero Section */}
      <section style={{ paddingTop: '6rem', paddingBottom: '4rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: 'clamp(2rem, 8vw, 3rem)', color: '#ECE0CC', marginBottom: '1rem' }}>
          Community Emergency Response Web App
        </h1>
        <p style={{ fontSize: '1.25rem', color: '#a2a586', maxWidth: '700px', margin: '0 auto 2rem', padding: '0 1rem' }}>
          Peer-to-peer decentralised emergency dispatch powered by Soroban smart contracts, ZK privacy proofs, and WebAuthn Passkeys.
        </p>

        {emergencyBroadcasterEnabled && (
          <div style={{ marginTop: '2rem' }}>
            <Link
              to="/help"
              style={{
                background: '#FF7A6B',
                color: '#fff',
                padding: '1rem 2rem',
                borderRadius: '0.5rem',
                textDecoration: 'none',
                fontWeight: 'bold',
                fontSize: '1.1rem',
              }}
            >
              Request Emergency Help Now
            </Link>
          </div>
        )}
      </section>
    </div>
  )
}

export default function App() {
  return (
    <FeatureFlagProvider>
      <WalletProvider>
        <AppContent />
      </WalletProvider>
    </FeatureFlagProvider>
  )
}
