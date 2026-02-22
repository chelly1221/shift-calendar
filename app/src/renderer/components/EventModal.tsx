import { DateTime } from 'luxon'
import { useEffect, useRef, useState } from 'react'
import type { RecurrenceEditScope, SendUpdates, UpsertCalendarEventInput } from '../../shared/calendar'
import { RecurrencePicker } from './RecurrencePicker'
import { parseRRule, recurrenceToRRule, type RecurrenceValue } from './recurrenceRule'
import { parseEducationTargets } from '../utils/parseEducationTargets'
import { parseVacationInfo, serializeVacationInfo, VACATION_TYPES, isPresetVacationType } from '../utils/parseVacationInfo'

export type EditableEvent = UpsertCalendarEventInput

interface EventModalProps {
  open: boolean
  value: EditableEvent | null
  memberNames: string[]
  onClose: () => void
  onSave: (event: EditableEvent) => Promise<void>
  onDelete: (localId: string, sendUpdates: SendUpdates, recurrenceScope?: RecurrenceEditScope) => Promise<void>
}

const EDUCATION_TARGET_PREFIX = '교육대상: '
const TIME_MEMO_PREFIX = '시각: '

function serializeEducationTargets(targets: string[], description: string): string {
  if (targets.length === 0) return description
  const line = `${EDUCATION_TARGET_PREFIX}${targets.join(', ')}`
  return description ? `${line}\n${description}` : line
}

function parseTimeMemo(description: string): { timeMemo: string; cleanDescription: string } {
  const lines = description.split('\n')
  if (lines.length > 0 && lines[0].startsWith(TIME_MEMO_PREFIX)) {
    const timeMemo = lines[0].slice(TIME_MEMO_PREFIX.length).trim()
    const cleanDescription = lines.slice(1).join('\n').trimStart()
    return { timeMemo, cleanDescription }
  }
  return { timeMemo: '', cleanDescription: description }
}

function serializeTimeMemo(timeMemo: string, description: string): string {
  if (!timeMemo.trim()) return description
  const line = `${TIME_MEMO_PREFIX}${timeMemo.trim()}`
  return description ? `${line}\n${description}` : line
}

function toDateInput(utcIso: string): string {
  const parsed = DateTime.fromISO(utcIso, { zone: 'utc' }).toLocal()
  return parsed.isValid ? parsed.toFormat('yyyy-MM-dd') : ''
}

function toEndDateInput(utcIso: string): string {
  const parsed = DateTime.fromISO(utcIso, { zone: 'utc' }).toLocal()
  if (!parsed.isValid) return ''
  if (parsed.hour === 0 && parsed.minute === 0 && parsed.second === 0) {
    return parsed.minus({ days: 1 }).toFormat('yyyy-MM-dd')
  }
  return parsed.toFormat('yyyy-MM-dd')
}

function dateToStartUtc(dateStr: string, tz: string): string {
  const parsed = DateTime.fromISO(dateStr, { zone: tz })
  if (!parsed.isValid) return new Date().toISOString()
  return parsed.startOf('day').toUTC().toISO() ?? new Date().toISOString()
}

function dateToEndUtc(dateStr: string, tz: string): string {
  const parsed = DateTime.fromISO(dateStr, { zone: tz })
  if (!parsed.isValid) return new Date().toISOString()
  return parsed.startOf('day').plus({ days: 1 }).toUTC().toISO() ?? new Date().toISOString()
}

function defaultEventDraft(): EditableEvent {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const start = DateTime.local().startOf('hour')
  const end = start.plus({ hours: 1 })

  return {
    eventType: '일반',
    summary: '',
    description: '',
    location: '',
    startAtUtc: start.toUTC().toISO() ?? new Date().toISOString(),
    endAtUtc: end.toUTC().toISO() ?? new Date().toISOString(),
    attendees: [],
    recurrenceRule: null,
    timeZone: zone,
    sendUpdates: 'none',
    recurrenceScope: 'ALL',
  }
}

export function EventModal({ open, value, memberNames, onClose, onSave, onDelete }: EventModalProps) {
  const [localId, setLocalId] = useState<string | undefined>(undefined)
  const [googleEventId, setGoogleEventId] = useState<string | null | undefined>(undefined)
  const [recurringEventId, setRecurringEventId] = useState<string | null | undefined>(undefined)
  const [originalStartTimeUtc, setOriginalStartTimeUtc] = useState<string | null | undefined>(undefined)
  const [eventType, setEventType] = useState('일반')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [timeMemo, setTimeMemo] = useState('')
  const [timeZone, setTimeZone] = useState('UTC')
  const [attendees, setAttendees] = useState('')
  const [educationTargets, setEducationTargets] = useState<Set<string>>(new Set())
  const [vacationTargets, setVacationTargets] = useState<Set<string>>(new Set())
  const [vacationType, setVacationType] = useState<string | null>(null)
  const [isCustomVacationType, setIsCustomVacationType] = useState(false)
  const [customVacationTypeText, setCustomVacationTypeText] = useState('')
  const [vacationTimeStart, setVacationTimeStart] = useState('')
  const [vacationTimeEnd, setVacationTimeEnd] = useState('')
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(parseRRule(null))
  const [sendUpdates, setSendUpdates] = useState<SendUpdates>('none')
  const [recurrenceScope, setRecurrenceScope] = useState<'THIS' | 'ALL' | 'FUTURE'>('ALL')
  const mouseDownTarget = useRef<EventTarget | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const source = value ?? defaultEventDraft()
    setLocalId(source.localId)
    setGoogleEventId(source.googleEventId)
    setRecurringEventId(source.recurringEventId)
    setOriginalStartTimeUtc(source.originalStartTimeUtc)
    setEventType(source.eventType ?? '일반')
    setSummary(source.summary)
    const rawDescription = source.description ?? ''
    let cleanDesc = rawDescription
    const sourceType = source.eventType ?? '일반'
    if (sourceType === '교육') {
      const parsed = parseEducationTargets(cleanDesc)
      cleanDesc = parsed.cleanDescription
      setEducationTargets(new Set(parsed.targets))
    } else {
      setEducationTargets(new Set())
    }
    if (sourceType === '휴가') {
      const parsed = parseVacationInfo(cleanDesc)
      cleanDesc = parsed.cleanDescription
      setVacationTargets(new Set(parsed.targets))
      if (parsed.vacationType && !isPresetVacationType(parsed.vacationType)) {
        setVacationType(parsed.vacationType)
        setIsCustomVacationType(true)
        setCustomVacationTypeText(parsed.vacationType)
      } else {
        setVacationType(parsed.vacationType)
        setIsCustomVacationType(false)
        setCustomVacationTypeText('')
      }
    } else {
      setVacationTargets(new Set())
      setVacationType(null)
      setIsCustomVacationType(false)
      setCustomVacationTypeText('')
    }
    const timeParsed = parseTimeMemo(cleanDesc)
    setTimeMemo(timeParsed.timeMemo)
    setDescription(timeParsed.cleanDescription)
    if (sourceType === '휴가') {
      const rangeParts = timeParsed.timeMemo.split('~').map((s) => s.trim())
      if (rangeParts.length === 2 && rangeParts[0] && rangeParts[1]) {
        setVacationTimeStart(rangeParts[0])
        setVacationTimeEnd(rangeParts[1])
      } else {
        setVacationTimeStart('')
        setVacationTimeEnd('')
      }
    } else {
      setVacationTimeStart('')
      setVacationTimeEnd('')
    }
    setLocation(source.location ?? '')
    setStartDate(toDateInput(source.startAtUtc))
    setEndDate(toEndDateInput(source.endAtUtc))
    setTimeZone(source.timeZone)
    setAttendees(source.attendees.join(', '))
    setRecurrence(parseRRule(source.recurrenceRule))
    setSendUpdates(source.sendUpdates)
    setRecurrenceScope(source.recurrenceScope)
  }, [open, value])

  if (!open) {
    return null
  }

  const hasExistingEvent = Boolean(localId)
  const hasRecurringContext =
    Boolean(recurrence.preset !== 'NONE')
    || Boolean(value?.recurrenceRule)
    || Boolean(value?.recurringEventId)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { mouseDownTarget.current = e.target }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) onClose() }}
    >
      <div className="event-modal">
        <div className="modal-header">
          <h2>{hasExistingEvent ? '일정 수정' : '일정 만들기'}</h2>
          <button type="button" className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </div>

        <form
          className="event-form"
          onSubmit={async (event) => {
            event.preventDefault()

            const startAtUtc = dateToStartUtc(startDate, timeZone)
            let endAtUtc = dateToEndUtc(endDate, timeZone)
            const startMillis = DateTime.fromISO(startAtUtc).toMillis()
            const endMillis = DateTime.fromISO(endAtUtc).toMillis()
            if (Number.isFinite(startMillis) && Number.isFinite(endMillis) && endMillis <= startMillis) {
              endAtUtc = DateTime.fromISO(startAtUtc).plus({ days: 1 }).toISO() ?? startAtUtc
            }

            const normalizedEventType = eventType.trim() || '일반'
            const normalizedOriginalType = value?.eventType?.trim() || '일반'
            const forceAllForTypeChange =
              hasExistingEvent
              && hasRecurringContext
              && normalizedEventType !== normalizedOriginalType

            const resolvedVacationType = isCustomVacationType
              ? (customVacationTypeText.trim() || null)
              : vacationType

            const effectiveTimeMemo =
              normalizedEventType === '휴가'
                ? (resolvedVacationType === '시간차' && vacationTimeStart && vacationTimeEnd
                    ? `${vacationTimeStart}~${vacationTimeEnd}`
                    : '')
                : timeMemo

            let finalDescription = serializeTimeMemo(effectiveTimeMemo, description.trim())
            if (normalizedEventType === '교육') {
              finalDescription = serializeEducationTargets([...educationTargets], finalDescription)
            }
            if (normalizedEventType === '휴가') {
              finalDescription = serializeVacationInfo([...vacationTargets], resolvedVacationType, finalDescription)
            }

            let effectiveSummary = summary.trim()
            if (normalizedEventType === '휴가') {
              const parts: string[] = []
              if (vacationTargets.size > 0) parts.push([...vacationTargets].join(', '))
              if (resolvedVacationType) {
                if (resolvedVacationType === '시간차' && vacationTimeStart && vacationTimeEnd) {
                  parts.push(`시간차(${vacationTimeStart}~${vacationTimeEnd})`)
                } else {
                  parts.push(resolvedVacationType)
                }
              }
              effectiveSummary = parts.length > 0 ? parts.join(' ') : '휴가'
            }

            await onSave({
              localId,
              googleEventId,
              eventType: normalizedEventType,
              summary: effectiveSummary,
              description: finalDescription,
              location: location.trim(),
              startAtUtc,
              endAtUtc,
              timeZone,
              attendees: attendees
                .split(',')
                .map((email) => email.trim())
                .filter((email) => email.length > 0),
              recurrenceRule: recurrenceToRRule(recurrence),
              recurringEventId,
              originalStartTimeUtc,
              sendUpdates,
              recurrenceScope: forceAllForTypeChange
                ? 'ALL'
                : hasExistingEvent && hasRecurringContext
                  ? recurrenceScope
                  : 'ALL',
            })
          }}
        >
          <label className="field-label" htmlFor="eventType">
            타입
          </label>
          <select
            id="eventType"
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            required
          >
            <option value="일반">일반</option>
            <option value="근무">근무</option>
            <option value="반복업무">반복업무</option>
            <option value="운용중지작업">운용중지작업</option>
            <option value="중요">중요</option>
            <option value="휴가">휴가</option>
            <option value="교육">교육</option>
          </select>

          {eventType !== '휴가' ? (
            <>
              <label className="field-label" htmlFor="eventSummary">
                {eventType === '교육' ? '교육명' : '제목'}
              </label>
              <input
                id="eventSummary"
                type="text"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="팀 미팅"
                required
              />
            </>
          ) : null}

          {eventType === '교육' && memberNames.length > 0 ? (
            <div className="education-targets">
              <label className="field-label">교육 대상</label>
              <div className="education-pill-grid">
                {memberNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={educationTargets.has(name) ? 'education-pill is-selected' : 'education-pill'}
                    onClick={() => {
                      setEducationTargets((prev) => {
                        const next = new Set(prev)
                        if (next.has(name)) {
                          next.delete(name)
                        } else {
                          next.add(name)
                        }
                        return next
                      })
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {eventType === '휴가' && memberNames.length > 0 ? (
            <div className="vacation-targets">
              <label className="field-label">대상자</label>
              <div className="education-pill-grid">
                {memberNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={vacationTargets.has(name) ? 'vacation-pill is-selected' : 'vacation-pill'}
                    onClick={() => {
                      setVacationTargets((prev) => {
                        const next = new Set(prev)
                        if (next.has(name)) {
                          next.delete(name)
                        } else {
                          next.add(name)
                        }
                        return next
                      })
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {eventType === '휴가' ? (
            <div className="vacation-targets">
              <label className="field-label">휴가 종류</label>
              <div className="education-pill-grid">
                {VACATION_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={!isCustomVacationType && vacationType === type ? 'vacation-pill is-selected' : 'vacation-pill'}
                    onClick={() => {
                      if (!isCustomVacationType && vacationType === type) {
                        setVacationType(null)
                      } else {
                        setVacationType(type)
                        setIsCustomVacationType(false)
                        setCustomVacationTypeText('')
                      }
                    }}
                  >
                    {type}
                  </button>
                ))}
                <button
                  type="button"
                  className={isCustomVacationType ? 'vacation-pill is-selected' : 'vacation-pill'}
                  onClick={() => {
                    if (isCustomVacationType) {
                      setIsCustomVacationType(false)
                      setCustomVacationTypeText('')
                      setVacationType(null)
                    } else {
                      setIsCustomVacationType(true)
                      setVacationType(null)
                    }
                  }}
                >
                  기타
                </button>
              </div>
              {isCustomVacationType ? (
                <input
                  type="text"
                  value={customVacationTypeText}
                  onChange={(event) => setCustomVacationTypeText(event.target.value)}
                  placeholder="휴가 종류 입력"
                  autoFocus
                />
              ) : null}
            </div>
          ) : null}

          <div className="form-grid">
            <div>
              <label className="field-label" htmlFor="startAt">
                시작일
              </label>
              <input
                id="startAt"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="endAt">
                종료일
              </label>
              <input
                id="endAt"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                required
              />
            </div>
          </div>

          {eventType === '휴가' && vacationType === '시간차' ? (
            <div className="form-grid">
              <div>
                <label className="field-label" htmlFor="vacationTimeStart">시작 시각</label>
                <input
                  id="vacationTimeStart"
                  type="time"
                  value={vacationTimeStart}
                  onChange={(event) => setVacationTimeStart(event.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="vacationTimeEnd">종료 시각</label>
                <input
                  id="vacationTimeEnd"
                  type="time"
                  value={vacationTimeEnd}
                  onChange={(event) => setVacationTimeEnd(event.target.value)}
                />
              </div>
            </div>
          ) : eventType !== '휴가' ? (
            <>
              <label className="field-label" htmlFor="timeMemo">시각 (선택)</label>
              <input
                id="timeMemo"
                type="text"
                value={timeMemo}
                onChange={(event) => setTimeMemo(event.target.value)}
                placeholder="예: 14:00"
              />
            </>
          ) : null}

          {eventType !== '교육' && eventType !== '휴가' && eventType !== '중요' && eventType !== '일반' ? (
            <RecurrencePicker value={recurrence} onChange={setRecurrence} />
          ) : null}

          {hasExistingEvent && hasRecurringContext ? (
            <>
              <label className="field-label" htmlFor="recurrenceScope">
                적용 범위
              </label>
              <select
                id="recurrenceScope"
                value={recurrenceScope}
                onChange={(event) =>
                  setRecurrenceScope(event.target.value as 'THIS' | 'ALL' | 'FUTURE')
                }
              >
                <option value="THIS">이 일정만</option>
                <option value="ALL">모든 일정</option>
                <option value="FUTURE">이 일정 및 향후 일정</option>
              </select>
            </>
          ) : null}

<div className="modal-actions">
            {hasExistingEvent ? (
              <button
                type="button"
                className="danger-button"
                onClick={async () => {
                  if (!localId) {
                    return
                  }
                  await onDelete(
                    localId,
                    sendUpdates,
                    hasRecurringContext ? recurrenceScope : undefined,
                  )
                }}
              >
                삭제
              </button>
            ) : (
              <span />
            )}
            <button type="submit" className="primary-button">
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
