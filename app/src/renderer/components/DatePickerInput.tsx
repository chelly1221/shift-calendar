import { DateTime } from 'luxon'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']
const POPUP_WIDTH = 240
const POPUP_HEIGHT = 300

interface DatePickerInputProps {
  id?: string
  value: string
  /** Called while typing, with the live-formatted text. */
  onChange: (value: string) => void
  /** Called on blur, outside-click, or calendar selection, with a normalized `yyyy-MM-dd`. */
  onCommit: (value: string) => void
  className?: string
  placeholder?: string
  required?: boolean
}

export function DatePickerInput({
  id,
  value,
  onChange,
  onCommit,
  className,
  placeholder = 'YYYY-MM-DD',
  required,
}: DatePickerInputProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const [viewMonth, setViewMonth] = useState<DateTime>(() => DateTime.local().startOf('month'))
  const wrapRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Align the calendar to the current value each time the popup opens.
  useEffect(() => {
    if (!open) return
    const parsed = DateTime.fromISO(value)
    setViewMonth((parsed.isValid ? parsed : DateTime.local()).startOf('month'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Position the (portaled) popup relative to the input, flipping when needed.
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      let left = rect.left
      if (left + POPUP_WIDTH > window.innerWidth - 8) left = window.innerWidth - 8 - POPUP_WIDTH
      if (left < 8) left = 8
      const flipUp =
        rect.bottom + POPUP_HEIGHT > window.innerHeight - 8 && rect.top - POPUP_HEIGHT > 8
      const top = flipUp ? rect.top - POPUP_HEIGHT - 4 : rect.bottom + 4
      setCoords({ left, top })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (wrapRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
      onCommit(normalizeDateText(value))
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, value, onCommit])

  const selected = DateTime.fromISO(value)
  const today = DateTime.local().startOf('day')
  const gridStart = viewMonth.minus({ days: viewMonth.weekday % 7 })
  const days = Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }))

  const pickDay = (day: DateTime) => {
    onCommit(day.toFormat('yyyy-MM-dd'))
    setOpen(false)
  }

  return (
    <div className="date-picker-wrap" ref={wrapRef}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className={className}
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        onChange={(event) => onChange(formatDateText(event.target.value))}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={(event) => {
          onCommit(normalizeDateText(value))
          if (!popupRef.current?.contains(event.relatedTarget as Node)) {
            setOpen(false)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {open
        ? createPortal(
            <div
              ref={popupRef}
              className="date-picker-popup"
              style={{ left: coords.left, top: coords.top }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <div className="dp-header">
                <button
                  type="button"
                  className="dp-nav"
                  aria-label="이전 달"
                  onClick={() => setViewMonth((m) => m.minus({ months: 1 }))}
                >
                  &lsaquo;
                </button>
                <span className="dp-title">{viewMonth.toFormat('yyyy년 M월')}</span>
                <button
                  type="button"
                  className="dp-nav"
                  aria-label="다음 달"
                  onClick={() => setViewMonth((m) => m.plus({ months: 1 }))}
                >
                  &rsaquo;
                </button>
              </div>
              <div className="dp-grid">
                {WEEKDAY_LABELS.map((label, i) => (
                  <span
                    key={label}
                    className={`dp-weekday${i === 0 ? ' is-sun' : ''}${i === 6 ? ' is-sat' : ''}`}
                  >
                    {label}
                  </span>
                ))}
                {days.map((day) => {
                  const isOutside = day.month !== viewMonth.month
                  const isSelected = selected.isValid && day.hasSame(selected, 'day')
                  const isToday = day.hasSame(today, 'day')
                  const weekday = day.weekday % 7
                  return (
                    <button
                      key={day.toISODate()}
                      type="button"
                      className={[
                        'dp-day',
                        isOutside ? 'is-outside' : '',
                        isSelected ? 'is-selected' : '',
                        isToday ? 'is-today' : '',
                        weekday === 0 ? 'is-sun' : '',
                        weekday === 6 ? 'is-sat' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => pickDay(day)}
                    >
                      {day.day}
                    </button>
                  )
                })}
              </div>
              <div className="dp-footer">
                <button
                  type="button"
                  className="dp-today-btn"
                  onClick={() => pickDay(DateTime.local())}
                >
                  오늘
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
