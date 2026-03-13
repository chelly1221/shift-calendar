import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CalendarEvent } from '../../shared/calendar'

type Phase = 'SUBSTITUTE' | 'TYPE' | 'ORIGINAL' | 'CLOSING'

interface SubstitutionFlowProps {
  anchor: { x: number; y: number }
  shiftEvent: CalendarEvent
  memberNames: string[]
  onComplete: (substitute: string, type: '대리근무' | '대체근무', original: string) => void
  onDismiss: () => void
}

const STEPS = ['대체근무자', '종류', '원근무자'] as const

export function SubstitutionFlow({ anchor, memberNames, onComplete, onDismiss }: SubstitutionFlowProps) {
  const [phase, setPhase] = useState<Phase>('SUBSTITUTE')
  const [substitute, setSubstitute] = useState<string | null>(null)
  const [workType, setWorkType] = useState<'대리근무' | '대체근무' | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const flowCardRef = useRef<HTMLDivElement>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startClosing = useCallback(() => {
    if (closingTimerRef.current) return
    setPhase('CLOSING')
    closingTimerRef.current = setTimeout(() => {
      onDismiss()
    }, 180)
  }, [onDismiss])

  useEffect(() => {
    return () => {
      if (closingTimerRef.current) clearTimeout(closingTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        startClosing()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [startClosing])

  // Clamp container position within viewport (not using transform, which the animation overrides)
  useLayoutEffect(() => {
    if (phase === 'CLOSING') return
    const container = containerRef.current
    const card = flowCardRef.current
    if (!container || !card) return
    const rect = card.getBoundingClientRect()
    if (rect.right > window.innerWidth - 12) {
      container.style.left = `${Math.max(12, anchor.x - (rect.right - window.innerWidth + 12))}px`
    }
    if (rect.bottom > window.innerHeight - 12) {
      container.style.top = `${Math.max(12, anchor.y - (rect.bottom - window.innerHeight + 12))}px`
    }
  }, [phase, anchor.x, anchor.y])

  const currentStep = phase === 'SUBSTITUTE' ? 0 : phase === 'TYPE' ? 1 : phase === 'ORIGINAL' ? 2 : 0
  const isClosing = phase === 'CLOSING'

  return (
    <>
      <div
        className="radial-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) startClosing()
        }}
      />
      <div
        ref={containerRef}
        className={`radial-menu-container${isClosing ? ' is-closing' : ''}`}
        style={{ left: anchor.x, top: anchor.y }}
      >
        <div ref={flowCardRef} className="radial-flow-card" key={phase}>
          {/* Step indicator */}
          <div className="radial-flow-steps">
            {STEPS.map((label, i) => (
              <span
                key={label}
                className={`radial-flow-step${i === currentStep ? ' is-active' : ''}${i < currentStep ? ' is-done' : ''}`}
              >
                {label}
              </span>
            ))}
          </div>

          {/* SUBSTITUTE phase */}
          {phase === 'SUBSTITUTE' && (
            <>
              <div className="radial-flow-card-header">
                <span className="radial-flow-back-btn" onClick={startClosing}>&lsaquo;</span>
                <span>대체근무자 선택</span>
              </div>
              <div className="radial-flow-pill-grid is-member-grid">
                {memberNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={substitute === name ? 'substitution-pill is-selected' : 'substitution-pill'}
                    onClick={() => setSubstitute(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="radial-flow-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!substitute}
                  onClick={() => setPhase('TYPE')}
                >
                  다음
                </button>
              </div>
            </>
          )}

          {/* TYPE phase */}
          {phase === 'TYPE' && (
            <>
              <div className="radial-flow-card-header">
                <span className="radial-flow-back-btn" onClick={() => setPhase('SUBSTITUTE')}>&lsaquo;</span>
                <span>근무 종류 선택</span>
              </div>
              <div className="radial-flow-pill-grid">
                <button
                  type="button"
                  className={workType === '대리근무' ? 'substitution-pill is-selected' : 'substitution-pill'}
                  onClick={() => {
                    setWorkType('대리근무')
                    setPhase('ORIGINAL')
                  }}
                >
                  대리근무
                </button>
                <button
                  type="button"
                  className={workType === '대체근무' ? 'substitution-pill is-selected' : 'substitution-pill'}
                  onClick={() => {
                    setWorkType('대체근무')
                    setPhase('ORIGINAL')
                  }}
                >
                  대체근무
                </button>
              </div>
            </>
          )}

          {/* ORIGINAL phase */}
          {phase === 'ORIGINAL' && (
            <>
              <div className="radial-flow-card-header">
                <span className="radial-flow-back-btn" onClick={() => setPhase('TYPE')}>&lsaquo;</span>
                <span>원근무자 선택</span>
              </div>
              <div className="radial-flow-pill-grid is-member-grid">
                {memberNames.filter((name) => name !== substitute).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="substitution-pill"
                    onClick={() => {
                      if (substitute && workType) {
                        onComplete(substitute, workType, name)
                      }
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
