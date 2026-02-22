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

function updatePreset(value: RecurrenceValue, preset: RecurrencePreset): RecurrenceValue {
  if (preset !== 'WEEKLY') {
    return {
      ...value,
      preset,
      weeklyDays: value.weeklyDays.length > 0 ? value.weeklyDays : ['MO'],
    }
  }

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
  return (
    <div className="recurrence-group">
      <label className="field-label" htmlFor="recurrencePreset">
        반복
      </label>

      <div className="recurrence-row">
        <select
          id="recurrencePreset"
          value={value.preset}
          onChange={(event) => onChange(updatePreset(value, event.target.value as RecurrencePreset))}
        >
          <option value="NONE">반복 안 함</option>
          <option value="DAILY">매일</option>
          <option value="WEEKLY">매주</option>
          <option value="MONTHLY">매월</option>
          <option value="YEARLY">매년</option>
        </select>
        <input
          type="number"
          min={1}
          max={99}
          value={value.interval}
          disabled={value.preset === 'NONE'}
          onChange={(event) => {
            const interval = Number.parseInt(event.target.value, 10)
            onChange({
              ...value,
              interval: Number.isNaN(interval) ? 1 : Math.max(1, interval),
            })
          }}
        />
      </div>

      {value.preset === 'WEEKLY' ? (
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
      ) : null}

      {value.preset === 'MONTHLY' ? (
        <>
          <label className="field-label" htmlFor="monthlyPattern">
            월간 패턴
          </label>
          <select
            id="monthlyPattern"
            value={value.monthlyPattern}
            onChange={(event) =>
              onChange({
                ...value,
                monthlyPattern: event.target.value as MonthlyPattern,
              })
            }
          >
            <option value="BY_MONTH_DAY">날짜 기준</option>
            <option value="BY_NTH_WEEKDAY">N번째 요일</option>
          </select>

          {value.monthlyPattern === 'BY_MONTH_DAY' ? (
            <div className="recurrence-row">
              <input
                type="number"
                min={1}
                max={31}
                value={value.monthDay}
                onChange={(event) => {
                  const monthDay = Number.parseInt(event.target.value, 10)
                  onChange({
                    ...value,
                    monthDay: Number.isNaN(monthDay) ? 1 : Math.min(31, Math.max(1, monthDay)),
                  })
                }}
              />
              <span className="inline-note">일</span>
            </div>
          ) : (
            <div className="recurrence-row recurrence-row-wide">
              <select
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
          )}
        </>
      ) : null}

    </div>
  )
}
