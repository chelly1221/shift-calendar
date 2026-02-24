import type {
  MonthlyByDay,
  MonthlyPattern,
  RecurrenceEndMode,
  RecurrencePreset,
  RecurrenceValue,
  WeekdayCode,
} from './recurrenceRule'
import { WEEKDAY_OPTIONS } from './recurrenceRule'

interface RecurrencePickerProps {
  value: RecurrenceValue
  onChange: (nextValue: RecurrenceValue) => void
}

const PRESET_OPTIONS: { value: RecurrencePreset; label: string }[] = [
  { value: 'NONE', label: '반복 안 함' },
  { value: 'DAILY', label: '매일' },
  { value: 'WEEKLY', label: '매주' },
  { value: 'MONTHLY', label: '매월' },
  { value: 'YEARLY', label: '매년' },
]

const FREQ_UNIT: Record<string, string> = {
  DAILY: '일',
  WEEKLY: '주',
  MONTHLY: '개월',
  YEARLY: '년',
}

const SET_POS_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '첫째' },
  { value: 2, label: '둘째' },
  { value: 3, label: '셋째' },
  { value: 4, label: '넷째' },
  { value: -1, label: '마지막' },
]

const MONTHLY_BY_DAY_OPTIONS: { value: MonthlyByDay; label: string }[] = [
  { value: 'MO', label: '월요일' },
  { value: 'TU', label: '화요일' },
  { value: 'WE', label: '수요일' },
  { value: 'TH', label: '목요일' },
  { value: 'FR', label: '금요일' },
  { value: 'SA', label: '토요일' },
  { value: 'SU', label: '일요일' },
  { value: 'WEEKDAY', label: '평일' },
]

const END_MODE_OPTIONS: { value: RecurrenceEndMode; label: string }[] = [
  { value: 'NEVER', label: '계속 반복' },
  { value: 'UNTIL', label: '날짜까지' },
  { value: 'COUNT', label: '횟수 지정' },
]

function updatePreset(value: RecurrenceValue, preset: RecurrencePreset): RecurrenceValue {
  return {
    ...value,
    preset,
    weeklyDays: value.weeklyDays.length > 0 ? value.weeklyDays : ['MO'],
  }
}

function toggleWeeklyDay(value: RecurrenceValue, day: WeekdayCode): RecurrenceValue {
  const exists = value.weeklyDays.includes(day)
  if (exists && value.weeklyDays.length === 1) {
    return value
  }
  const weeklyDays = exists
    ? value.weeklyDays.filter((item) => item !== day)
    : [...value.weeklyDays, day]
  return {
    ...value,
    weeklyDays,
  }
}

export function RecurrencePicker({ value, onChange }: RecurrencePickerProps) {
  const isActive = value.preset !== 'NONE'

  return (
    <div className="recurrence-picker">
      <label className="field-label">반복 설정</label>

      {/* ── Preset pills ── */}
      <div className="recurrence-preset-pills">
        {PRESET_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={value.preset === opt.value ? 'recurrence-pill is-selected' : 'recurrence-pill'}
            onClick={() => onChange(updatePreset(value, opt.value))}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isActive ? (
        <div className="recurrence-detail-box">
          {/* ── Interval ── */}
          <div className="recurrence-interval-row">
            <span className="recurrence-interval-label">매</span>
            <input
              type="number"
              className="recurrence-interval-input"
              min={1}
              max={99}
              value={value.interval}
              onChange={(event) => {
                const interval = Number.parseInt(event.target.value, 10)
                onChange({
                  ...value,
                  interval: Number.isNaN(interval) ? 1 : Math.max(1, interval),
                })
              }}
            />
            <span className="recurrence-interval-label">{FREQ_UNIT[value.preset]}마다</span>
          </div>

          {/* ── Weekly: day buttons ── */}
          {value.preset === 'WEEKLY' ? (
            <div className="recurrence-section">
              <span className="recurrence-section-label">반복 요일</span>
              <div className="weekly-day-grid">
                {WEEKDAY_OPTIONS.map((day) => {
                  const selected = value.weeklyDays.includes(day.code)
                  return (
                    <button
                      key={day.code}
                      type="button"
                      className={selected ? 'weekday-button is-active' : 'weekday-button'}
                      onClick={() => onChange(toggleWeeklyDay(value, day.code))}
                    >
                      {day.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {/* ── Monthly: pattern ── */}
          {value.preset === 'MONTHLY' ? (
            <div className="recurrence-section">
              <span className="recurrence-section-label">월간 패턴</span>
              <div className="recurrence-monthly-toggle">
                <button
                  type="button"
                  className={value.monthlyPattern === 'BY_MONTH_DAY' ? 'recurrence-pill is-selected' : 'recurrence-pill'}
                  onClick={() => onChange({ ...value, monthlyPattern: 'BY_MONTH_DAY' as MonthlyPattern })}
                >
                  날짜 기준
                </button>
                <button
                  type="button"
                  className={value.monthlyPattern === 'BY_NTH_WEEKDAY' ? 'recurrence-pill is-selected' : 'recurrence-pill'}
                  onClick={() => onChange({ ...value, monthlyPattern: 'BY_NTH_WEEKDAY' as MonthlyPattern })}
                >
                  N번째 요일
                </button>
              </div>

              {value.monthlyPattern !== 'BY_MONTH_DAY' ? (
                <div className="recurrence-interval-row">
                  <span className="recurrence-interval-label">매월</span>
                  <select
                    className="recurrence-inline-select"
                    value={value.bySetPos}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        bySetPos: Number.parseInt(event.target.value, 10),
                      })
                    }
                  >
                    {SET_POS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="recurrence-inline-select"
                    value={value.monthlyByDay}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        monthlyByDay: event.target.value as MonthlyByDay,
                      })
                    }
                  >
                    {MONTHLY_BY_DAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── End condition ── */}
          <div className="recurrence-section">
            <span className="recurrence-section-label">종료 조건</span>
            <div className="recurrence-end-pills">
              {END_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={value.endMode === opt.value ? 'recurrence-pill is-selected' : 'recurrence-pill'}
                  onClick={() => onChange({ ...value, endMode: opt.value })}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {value.endMode === 'UNTIL' ? (
              <div className="recurrence-interval-row">
                <span className="recurrence-interval-label">종료일</span>
                <input
                  type="date"
                  className="recurrence-date-input"
                  value={value.untilDate}
                  onChange={(event) => onChange({ ...value, untilDate: event.target.value })}
                />
              </div>
            ) : null}

            {value.endMode === 'COUNT' ? (
              <div className="recurrence-interval-row">
                <input
                  type="number"
                  className="recurrence-interval-input"
                  min={1}
                  max={999}
                  value={value.count}
                  onChange={(event) => {
                    const count = Number.parseInt(event.target.value, 10)
                    onChange({
                      ...value,
                      count: Number.isNaN(count) ? 1 : Math.max(1, count),
                    })
                  }}
                />
                <span className="recurrence-interval-label">회 반복</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
