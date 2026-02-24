import { DateTime } from 'luxon'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EditableEvent } from './EventModal'
import { RecurrencePicker } from './RecurrencePicker'
import { parseRRule, recurrenceToRRule, type RecurrenceValue } from './recurrenceRule'
import { serializeVacationInfo, VACATION_TYPES } from '../utils/parseVacationInfo'

const EDUCATION_TARGET_PREFIX = '교육대상: '
const TIME_MEMO_PREFIX = '시각: '

function serializeEducationTargets(targets: string[], description: string): string {
  if (targets.length === 0) return description
  const line = `${EDUCATION_TARGET_PREFIX}${targets.join(', ')}`
  return description ? `${line}\n${description}` : line
}

function serializeTimeMemo(timeMemo: string, description: string): string {
  if (!timeMemo.trim()) return description
  const line = `${TIME_MEMO_PREFIX}${timeMemo.trim()}`
  return description ? `${line}\n${description}` : line
}

function formatTimeText(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}:${digits.slice(2)}`
}

function formatDateText(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 4) return digits
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
}

function normalizeDateText(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const now = DateTime.local()
  let year: number, month: number, day: number
  if (digits.length === 4) {
    year = now.year
    month = parseInt(digits.slice(0, 2), 10)
    day = parseInt(digits.slice(2, 4), 10)
  } else if (digits.length === 6) {
    year = 2000 + parseInt(digits.slice(0, 2), 10)
    month = parseInt(digits.slice(2, 4), 10)
    day = parseInt(digits.slice(4, 6), 10)
  } else if (digits.length === 8) {
    year = parseInt(digits.slice(0, 4), 10)
    month = parseInt(digits.slice(4, 6), 10)
    day = parseInt(digits.slice(6, 8), 10)
  } else {
    return raw
  }
  const dt = DateTime.local(year, month, day)
  return dt.isValid ? dt.toFormat('yyyy-MM-dd') : raw
}

type Phase =
  | 'TYPE_SELECT'
  | 'VACATION_TARGETS'
  | 'VACATION_TYPE'
  | 'VACATION_TIME'
  | 'EDUCATION_TARGETS'
  | 'TITLE'
  | 'RECURRENCE'
  | 'DATE_RANGE'
  | 'CLOSING'

interface RadialMenuProps {
  anchor: { x: number; y: number }
  dateStr: string
  memberNames: string[]
  onComplete: (draft: EditableEvent) => void
  onDismiss: () => void
}

/* SVG icon paths (16×16 viewBox) */
const ICONS: Record<string, string> = {
  '일반': 'M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11ZM5 5h6M5 8h6M5 11h3',
  '휴가': 'M8 1v3M4.5 2.5 8 5.5l3.5-3M2 8c0 3.5 2.5 7 6 7s6-3.5 6-7H2Z',
  '교육': 'M1 6l7-4 7 4-7 4-7-4Zm3 2v3.5c0 1 1.8 2 4 2s4-1 4-2V8',
  '반복업무': 'M2.5 8a5.5 5.5 0 0 1 9.5-3.7M13.5 8a5.5 5.5 0 0 1-9.5 3.7M12 1v3.5h-3.5M4 15v-3.5h3.5',
  '중요': 'M8 1l2.2 4.6L15 6.3l-3.5 3.5.8 4.9L8 12.4l-4.3 2.3.8-4.9L1 6.3l4.8-.7L8 1Z',
}

const EVENT_TYPES = [
  { type: '일반', label: '일반', color: '#3478f6' },
  { type: '휴가', label: '휴가', color: '#636366' },
  { type: '교육', label: '교육', color: '#0d9488' },
  { type: '반복업무', label: '반복', color: '#af52de' },
  { type: '중요', label: '중요', color: '#ff3b30' },
] as const

const PAD = 12

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function positionByCorner(anchor: { x: number; y: number }, width: number, height: number): { left: number; top: number } {
  let left = anchor.x
  let top = anchor.y

  const overflowRight = left + width > window.innerWidth - PAD
  const overflowBottom = top + height > window.innerHeight - PAD

  // default: top-left at cursor
  // right overflow: top-right at cursor
  // bottom overflow: bottom-left at cursor
  // right+bottom overflow: bottom-right at cursor
  if (overflowRight) {
    left = anchor.x - width
  }
  if (overflowBottom) {
    top = anchor.y - height
  }

  const maxLeft = Math.max(PAD, window.innerWidth - PAD - width)
  const maxTop = Math.max(PAD, window.innerHeight - PAD - height)

  return {
    left: clamp(left, PAD, maxLeft),
    top: clamp(top, PAD, maxTop),
  }
}

function clampPosition(anchor: { x: number; y: number }): { left: number; top: number } {
  const estimatedW = 220
  const estimatedH = 220
  return positionByCorner(anchor, estimatedW, estimatedH)
}

export function RadialMenu({ anchor, dateStr, memberNames, onComplete, onDismiss }: RadialMenuProps) {
  const [phase, setPhase] = useState<Phase>('TYPE_SELECT')
  const [selectedEventType, setSelectedEventType] = useState<string>('일반')
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(() => parseRRule(null))
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set())
  const [selectedVacationType, setSelectedVacationType] = useState<string | null>(null)
  const [vacationTimeStart, setVacationTimeStart] = useState('')
  const [vacationTimeEnd, setVacationTimeEnd] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftStartDate, setDraftStartDate] = useState(dateStr)
  const [draftEndDate, setDraftEndDate] = useState(dateStr)

  const containerRef = useRef<HTMLDivElement>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const pos = clampPosition(anchor)

  const finalize = useCallback(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const startAtUtc =
      DateTime.fromISO(draftStartDate, { zone }).startOf('day').toUTC().toISO() ??
      new Date().toISOString()
    let endAtUtc =
      DateTime.fromISO(draftEndDate, { zone }).startOf('day').plus({ days: 1 }).toUTC().toISO() ??
      new Date(Date.now() + 86400000).toISOString()

    const startMs = DateTime.fromISO(startAtUtc).toMillis()
    const endMs = DateTime.fromISO(endAtUtc).toMillis()
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
      endAtUtc = DateTime.fromISO(startAtUtc).plus({ days: 1 }).toISO() ?? startAtUtc
    }

    let description = ''
    let summary = draftTitle.trim()

    if (selectedEventType === '휴가') {
      const targets = [...selectedTargets]
      const vacationTimeRange =
        selectedVacationType === '시간차' && vacationTimeStart && vacationTimeEnd
          ? `${vacationTimeStart}~${vacationTimeEnd}`
          : ''
      description = serializeTimeMemo(vacationTimeRange, '')
      description = serializeVacationInfo(targets, selectedVacationType, description)
      const parts: string[] = []
      if (targets.length > 0) parts.push(targets.join(', '))
      if (selectedVacationType) {
        if (selectedVacationType === '시간차' && vacationTimeRange) {
          parts.push(`시간차(${vacationTimeRange})`)
        } else {
          parts.push(selectedVacationType)
        }
      }
      summary = parts.length > 0 ? parts.join(' ') : '휴가'
    } else if (selectedEventType === '교육') {
      description = serializeEducationTargets([...selectedTargets], '')
    }

    const recurrenceRule = selectedEventType === '반복업무' ? recurrenceToRRule(recurrence) : null

    onComplete({
      eventType: selectedEventType,
      summary,
      description,
      location: '',
      startAtUtc,
      endAtUtc,
      timeZone: zone,
      attendees: [],
      recurrenceRule,
      sendUpdates: 'none',
      recurrenceScope: 'ALL',
    })
  }, [
    draftStartDate,
    draftEndDate,
    draftTitle,
    selectedEventType,
    recurrence,
    selectedTargets,
    selectedVacationType,
    vacationTimeStart,
    vacationTimeEnd,
    onComplete,
  ])

  const startClosing = useCallback(() => {
    setPhase('CLOSING')
    closingTimerRef.current = setTimeout(() => {
      onDismiss()
    }, 160)
  }, [onDismiss])

  useEffect(() => {
    return () => {
      if (closingTimerRef.current) clearTimeout(closingTimerRef.current)
    }
  }, [])

  // Escape key
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

  // Auto-focus title input
  useEffect(() => {
    if (phase === 'TITLE') {
      requestAnimationFrame(() => titleInputRef.current?.focus())
    }
  }, [phase])

  // Keep corner-based positioning even when flow size changes
  useLayoutEffect(() => {
    if (phase === 'CLOSING') return
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const positioned = positionByCorner(anchor, rect.width, rect.height)
    el.style.left = `${positioned.left}px`
    el.style.top = `${positioned.top}px`
  }, [phase, anchor])

  // ── Phase transitions ──

  const handleTypeSelect = (eventType: string) => {
    setSelectedEventType(eventType)
    setRecurrence(eventType === '반복업무' ? parseRRule('FREQ=DAILY;INTERVAL=1') : parseRRule(null))
    if (eventType === '휴가' && memberNames.length > 0) {
      setPhase('VACATION_TARGETS')
      return
    }
    if (eventType === '교육' && memberNames.length > 0) {
      setPhase('EDUCATION_TARGETS')
      return
    }
    setPhase('TITLE')
  }

  const goBackFromTitle = () => {
    if (selectedEventType === '교육') {
      setPhase('EDUCATION_TARGETS')
    } else {
      setDraftTitle('')
      setPhase('TYPE_SELECT')
    }
  }

  const goBackFromDateRange = () => {
    if (selectedEventType === '휴가') {
      setPhase('VACATION_TYPE')
    } else if (selectedEventType === '반복업무') {
      setPhase('RECURRENCE')
    } else {
      setPhase('TITLE')
    }
  }

  const handleTitleNext = () => {
    if (selectedEventType === '반복업무') {
      setPhase('RECURRENCE')
      return
    }
    setPhase('DATE_RANGE')
  }

  const handleVacationTargetsNext = () => {
    setPhase('VACATION_TYPE')
  }

  const handleVacationTypeSelect = (vType: string) => {
    setSelectedVacationType(vType)
    if (vType === '시간차') {
      setDraftStartDate(dateStr)
      setDraftEndDate(dateStr)
      setPhase('VACATION_TIME')
      return
    }
    setPhase('DATE_RANGE')
  }

  const handleEducationTargetsNext = () => {
    setPhase('TITLE')
  }

  const toggleTarget = (name: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const isClosing = phase === 'CLOSING'
  const showFlow = phase !== 'TYPE_SELECT' && phase !== 'CLOSING'

  const titleLabel = selectedEventType === '교육' ? '교육명을 입력하세요' : '제목을 입력하세요'

  // Step indicator
  const stepInfo = (() => {
    if (selectedEventType === '휴가') {
      const steps = ['대상', '종류', selectedVacationType === '시간차' ? '시간' : '기간']
      const current =
        phase === 'VACATION_TARGETS'
          ? 0
          : phase === 'VACATION_TYPE'
            ? 1
            : phase === 'DATE_RANGE' || phase === 'VACATION_TIME'
              ? 2
              : 0
      return { steps, current }
    }
    if (selectedEventType === '교육') {
      const steps = ['대상', '교육명', '기간']
      const current =
        phase === 'EDUCATION_TARGETS' ? 0 : phase === 'TITLE' ? 1 : phase === 'DATE_RANGE' ? 2 : 0
      return { steps, current }
    }
    if (selectedEventType === '반복업무') {
      const steps = ['제목', '반복', '기간']
      const current =
        phase === 'TITLE' ? 0 : phase === 'RECURRENCE' ? 1 : phase === 'DATE_RANGE' ? 2 : 0
      return { steps, current }
    }
    const steps = ['제목', '기간']
    const current = phase === 'TITLE' ? 0 : phase === 'DATE_RANGE' ? 1 : 0
    return { steps, current }
  })()

  return (
    <>
      <div
        className="qmenu-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) startClosing()
        }}
      />
      <div
        ref={containerRef}
        className={`qmenu-container${isClosing ? ' is-closing' : ''}`}
        style={{ left: pos.left, top: pos.top }}
      >
        {phase === 'TYPE_SELECT' && (
          <div className="qmenu-pill-stack">
            {EVENT_TYPES.map((item, index) => (
              <button
                key={item.type}
                type="button"
                className="qmenu-pill-btn"
                onClick={() => handleTypeSelect(item.type)}
                style={{ animationDelay: `${index * 35}ms` }}
                tabIndex={0}
              >
                <svg className="qmenu-pill-icon" viewBox="0 0 16 16" fill="none" style={{ color: item.color }}>
                  <path d={ICONS[item.type]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill={item.type === '중요' ? 'currentColor' : 'none'} />
                </svg>
                <span className="qmenu-pill-label">{item.label}</span>
              </button>
            ))}
          </div>
        )}

        {showFlow && (
          <div className="qmenu-flow" key={phase}>
            {/* Step indicator */}
            <div className="qmenu-steps">
              {stepInfo.steps.map((label, i) => (
                <span
                  key={label}
                  className={`qmenu-step${i === stepInfo.current ? ' is-active' : ''}${i < stepInfo.current ? ' is-done' : ''}`}
                >
                  {label}
                </span>
              ))}
            </div>

            {/* ── VACATION_TARGETS ── */}
            {phase === 'VACATION_TARGETS' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={() => { setSelectedTargets(new Set()); setPhase('TYPE_SELECT') }}>&lsaquo;</button>
                  <span>휴가 대상</span>
                </div>
                <div className="qmenu-pill-grid is-member-grid">
                  {memberNames.map((name) => (
                    <button key={name} type="button" className={selectedTargets.has(name) ? 'qmenu-pill is-selected' : 'qmenu-pill'} onClick={() => toggleTarget(name)}>{name}</button>
                  ))}
                </div>
                <div className="qmenu-actions">
                  <button type="button" className="qmenu-action-btn primary" disabled={selectedTargets.size === 0} onClick={handleVacationTargetsNext}>다음</button>
                </div>
              </>
            )}

            {/* ── VACATION_TYPE ── */}
            {phase === 'VACATION_TYPE' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={() => setPhase('VACATION_TARGETS')}>&lsaquo;</button>
                  <span>휴가 종류</span>
                </div>
                <div className="qmenu-pill-grid">
                  {VACATION_TYPES.map((vType) => (
                    <button key={vType} type="button" className={selectedVacationType === vType ? 'qmenu-pill is-selected' : 'qmenu-pill'} onClick={() => handleVacationTypeSelect(vType)}>{vType}</button>
                  ))}
                </div>
              </>
            )}

            {/* ── EDUCATION_TARGETS ── */}
            {phase === 'EDUCATION_TARGETS' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={() => { setSelectedTargets(new Set()); setPhase('TYPE_SELECT') }}>&lsaquo;</button>
                  <span>교육 대상</span>
                </div>
                <div className="qmenu-pill-grid is-member-grid">
                  {memberNames.map((name) => (
                    <button key={name} type="button" className={selectedTargets.has(name) ? 'qmenu-pill is-selected' : 'qmenu-pill'} onClick={() => toggleTarget(name)}>{name}</button>
                  ))}
                </div>
                <div className="qmenu-actions">
                  <button type="button" className="qmenu-action-btn primary" disabled={selectedTargets.size === 0} onClick={handleEducationTargetsNext}>다음</button>
                </div>
              </>
            )}

            {/* ── TITLE ── */}
            {phase === 'TITLE' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={goBackFromTitle}>&lsaquo;</button>
                  <span>{titleLabel}</span>
                </div>
                <input
                  ref={titleInputRef}
                  type="text"
                  className="qmenu-input"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder={selectedEventType === '교육' ? '교육명' : '제목'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && draftTitle.trim()) {
                      e.preventDefault()
                      handleTitleNext()
                    }
                  }}
                />
                <div className="qmenu-actions">
                  <button type="button" className="qmenu-action-btn primary" disabled={!draftTitle.trim()} onClick={handleTitleNext}>다음</button>
                </div>
              </>
            )}

            {/* ── RECURRENCE (for routine) ── */}
            {phase === 'RECURRENCE' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={() => setPhase('TITLE')}>&lsaquo;</button>
                  <span>반복 설정</span>
                </div>
                <RecurrencePicker value={recurrence} onChange={setRecurrence} />
                <div className="qmenu-actions">
                  <button type="button" className="qmenu-action-btn primary" onClick={() => setPhase('DATE_RANGE')}>다음</button>
                </div>
              </>
            )}

            {/* ── DATE_RANGE ── */}
            {phase === 'DATE_RANGE' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={goBackFromDateRange}>&lsaquo;</button>
                  <span>기간 설정</span>
                </div>
                <div className="qmenu-date-row">
                  <div className="qmenu-date-field">
                    <label className="qmenu-field-label">시작</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="qmenu-input"
                      value={draftStartDate}
                      onChange={(e) => setDraftStartDate(formatDateText(e.target.value))}
                      onBlur={() => {
                        const normalized = normalizeDateText(draftStartDate)
                        setDraftStartDate(normalized)
                        if (draftEndDate && normalized > draftEndDate) setDraftEndDate(normalized)
                      }}
                      placeholder="YYYY-MM-DD"
                    />
                  </div>
                  <span className="qmenu-date-sep">&ndash;</span>
                  <div className="qmenu-date-field">
                    <label className="qmenu-field-label">종료</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="qmenu-input"
                      value={draftEndDate}
                      onChange={(e) => setDraftEndDate(formatDateText(e.target.value))}
                      onBlur={() => setDraftEndDate(normalizeDateText(draftEndDate))}
                      placeholder="YYYY-MM-DD"
                    />
                  </div>
                </div>
                <div className="qmenu-actions">
                  <button type="button" className="qmenu-action-btn primary" onClick={finalize}>완료</button>
                </div>
              </>
            )}

            {/* ── VACATION_TIME ── */}
            {phase === 'VACATION_TIME' && (
              <>
                <div className="qmenu-flow-header">
                  <button type="button" className="qmenu-back" onClick={() => setPhase('VACATION_TYPE')}>&lsaquo;</button>
                  <span>시간 설정</span>
                </div>
                <div className="qmenu-date-row">
                  <div className="qmenu-date-field">
                    <label className="qmenu-field-label">시작</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="qmenu-input"
                      value={vacationTimeStart}
                      onChange={(e) => setVacationTimeStart(formatTimeText(e.target.value))}
                      placeholder="09:00"
                    />
                  </div>
                  <span className="qmenu-date-sep">&ndash;</span>
                  <div className="qmenu-date-field">
                    <label className="qmenu-field-label">종료</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="qmenu-input"
                      value={vacationTimeEnd}
                      onChange={(e) => setVacationTimeEnd(formatTimeText(e.target.value))}
                      placeholder="13:00"
                    />
                  </div>
                </div>
                <div className="qmenu-actions">
                  <button
                    type="button"
                    className="qmenu-action-btn primary"
                    onClick={finalize}
                    disabled={!vacationTimeStart || !vacationTimeEnd}
                  >
                    완료
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
