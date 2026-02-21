import { DateTime } from 'luxon'
import { useEffect, useState } from 'react'
import type { SendUpdates, UpsertCalendarEventInput } from '../../shared/calendar'
import { RecurrencePicker } from './RecurrencePicker'
import { parseRRule, recurrenceToRRule, type RecurrenceValue } from './recurrenceRule'

export type EditableEvent = UpsertCalendarEventInput

interface EventModalProps {
  open: boolean
  value: EditableEvent | null
  onClose: () => void
  onSave: (event: EditableEvent) => Promise<void>
  onDelete: (localId: string, sendUpdates: SendUpdates) => Promise<void>
}

const LOCAL_INPUT_FORMAT = "yyyy-LL-dd'T'HH:mm"

function toLocalInput(utcIso: string): string {
  const parsed = DateTime.fromISO(utcIso, { zone: 'utc' }).toLocal()
  return parsed.isValid ? parsed.toFormat(LOCAL_INPUT_FORMAT) : ''
}

function toUtcIso(localValue: string, timeZone: string): string {
  const parsed = DateTime.fromISO(localValue, { zone: timeZone })
  if (!parsed.isValid) {
    return new Date().toISOString()
  }
  return parsed.toUTC().toISO() ?? new Date().toISOString()
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

export function EventModal({ open, value, onClose, onSave, onDelete }: EventModalProps) {
  const [localId, setLocalId] = useState<string | undefined>(undefined)
  const [googleEventId, setGoogleEventId] = useState<string | null | undefined>(undefined)
  const [recurringEventId, setRecurringEventId] = useState<string | null | undefined>(undefined)
  const [originalStartTimeUtc, setOriginalStartTimeUtc] = useState<string | null | undefined>(undefined)
  const [eventType, setEventType] = useState('일반')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [startLocal, setStartLocal] = useState('')
  const [endLocal, setEndLocal] = useState('')
  const [timeZone, setTimeZone] = useState('UTC')
  const [attendees, setAttendees] = useState('')
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(parseRRule(null))
  const [sendUpdates, setSendUpdates] = useState<SendUpdates>('none')
  const [recurrenceScope, setRecurrenceScope] = useState<'THIS' | 'ALL' | 'FUTURE'>('ALL')

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
    setDescription(source.description ?? '')
    setLocation(source.location ?? '')
    setStartLocal(toLocalInput(source.startAtUtc))
    setEndLocal(toLocalInput(source.endAtUtc))
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="event-modal" onClick={(event) => event.stopPropagation()}>
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

            const startAtUtc = toUtcIso(startLocal, timeZone)
            let endAtUtc = toUtcIso(endLocal, timeZone)
            const startMillis = DateTime.fromISO(startAtUtc).toMillis()
            const endMillis = DateTime.fromISO(endAtUtc).toMillis()
            if (Number.isFinite(startMillis) && Number.isFinite(endMillis) && endMillis <= startMillis) {
              endAtUtc = DateTime.fromISO(startAtUtc).plus({ hours: 1 }).toISO() ?? startAtUtc
            }

            const normalizedEventType = eventType.trim() || '일반'
            const normalizedOriginalType = value?.eventType?.trim() || '일반'
            const forceAllForTypeChange =
              hasExistingEvent
              && hasRecurringContext
              && normalizedEventType !== normalizedOriginalType

            await onSave({
              localId,
              googleEventId,
              eventType: normalizedEventType,
              summary: summary.trim(),
              description: description.trim(),
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
          <label className="field-label" htmlFor="eventSummary">
            제목
          </label>
          <input
            id="eventSummary"
            type="text"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="팀 미팅"
            required
          />

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
          </select>

          <label className="field-label" htmlFor="eventDescription">
            설명
          </label>
          <textarea
            id="eventDescription"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="메모, 안건, 링크..."
            rows={3}
          />

          <label className="field-label" htmlFor="eventLocation">
            장소
          </label>
          <input
            id="eventLocation"
            type="text"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="회의실 또는 주소"
          />

          <div className="form-grid">
            <div>
              <label className="field-label" htmlFor="startAt">
                시작
              </label>
              <input
                id="startAt"
                type="datetime-local"
                value={startLocal}
                onChange={(event) => setStartLocal(event.target.value)}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="endAt">
                종료
              </label>
              <input
                id="endAt"
                type="datetime-local"
                value={endLocal}
                onChange={(event) => setEndLocal(event.target.value)}
                required
              />
            </div>
          </div>

          <label className="field-label" htmlFor="timeZone">
            시간대
          </label>
          <input
            id="timeZone"
            type="text"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            placeholder="Asia/Seoul"
            required
          />

          <label className="field-label" htmlFor="attendees">
            참석자 (쉼표로 구분된 이메일)
          </label>
          <input
            id="attendees"
            type="text"
            value={attendees}
            onChange={(event) => setAttendees(event.target.value)}
            placeholder="hong@company.com, kim@company.com"
          />

          <RecurrencePicker value={recurrence} onChange={setRecurrence} />

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

          <label className="checkbox-row" htmlFor="sendUpdates">
            <input
              id="sendUpdates"
              type="checkbox"
              checked={sendUpdates === 'all'}
              onChange={(event) => setSendUpdates(event.target.checked ? 'all' : 'none')}
            />
            <span>참석자에게 업데이트 이메일 보내기</span>
          </label>

          <div className="modal-actions">
            {hasExistingEvent ? (
              <button
                type="button"
                className="danger-button"
                onClick={async () => {
                  if (!localId) {
                    return
                  }
                  await onDelete(localId, sendUpdates)
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
