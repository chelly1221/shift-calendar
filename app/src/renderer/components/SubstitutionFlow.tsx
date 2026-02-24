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

  const flowCardRef = useRef<HTMLDivElement>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startClosing = useCallback(() => {
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

  // Clamp flow card within viewport
  useLayoutEffect(() => {
    if (phase === 'CLOSING') return
    const el = flowCardRef.current
    if (!el) return
    el.style.transform = ''
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      let dx = 0
      let dy = 0
      if (rect.right > window.innerWidth - 12) dx = window.innerWidth - 12 - rect.right
      if (rect.left < 12) dx = 12 - rect.left
      if (rect.bottom > window.innerHeight - 12) dy = window.innerHeight - 12 - rect.bottom
      if (rect.top < 12) dy = 12 - rect.top
      if (dx !== 0 || dy !== 0) {
        el.style.transform = `translate(${dx}px, ${dy}px)`
      }
    })
  }, [phase])

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
                {memberNames.map((name) => (
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
