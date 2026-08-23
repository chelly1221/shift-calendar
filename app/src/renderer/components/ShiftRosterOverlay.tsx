import { useEffect } from 'react'

export interface ShiftRosterDay {
  dateIso: string
  dayLabel: string
  weekdayLabel: string
  isToday: boolean
  isWeekend: boolean
  holidayName: string | null
  dayTeams: string[]
  nightTeams: string[]
  dayMembers: string[]
  nightMembers: string[]
  dayWorkerNames: string[]
  hideDayWorkers: boolean
  hasShiftTeams: boolean
  vacations: { name: string; type: string | null }[]
}

interface ShiftRosterOverlayProps {
  open: boolean
  days: ShiftRosterDay[]
  onClose: () => void
}

function NameList({ names, emptyLabel }: { names: string[]; emptyLabel?: string }) {
  if (names.length === 0) {
    return emptyLabel ? <span className="roster-empty">{emptyLabel}</span> : null
  }
  return (
    <>
      {names.map((name) => (
        <span key={name} className="roster-name">{name}</span>
      ))}
    </>
  )
}

function RosterWeek({ days, title }: { days: ShiftRosterDay[]; title: string }) {
  return (
    <section className="roster-week" aria-label={title}>
      <div className="roster-grid">
        <div className="roster-corner">{title}</div>
        {days.map((day) => (
          <div
            key={day.dateIso}
            className={`roster-day-header${day.isToday ? ' is-today' : ''}${day.isWeekend || day.holidayName ? ' is-offday' : ''}`}
          >
            <span className="roster-day-date">{day.dayLabel}</span>
            <span className="roster-day-weekday">{day.holidayName ?? day.weekdayLabel}</span>
          </div>
        ))}

        <div className="roster-row-label roster-row-dayworker">일근</div>
        {days.map((day) => (
          <div key={`${day.dateIso}-dw`} className={`roster-cell roster-row-dayworker${day.isToday ? ' is-today' : ''}`}>
            {day.hideDayWorkers ? <span className="roster-empty">—</span> : <NameList names={day.dayWorkerNames} emptyLabel="—" />}
          </div>
        ))}

        <div className="roster-row-label roster-row-day">주간</div>
        {days.map((day) => (
          <div key={`${day.dateIso}-day`} className={`roster-cell roster-row-day${day.isToday ? ' is-today' : ''}`}>
            {day.hasShiftTeams ? (
              <>
                <span className="roster-team">{day.dayTeams.join('·')}</span>
                <NameList names={day.dayMembers} emptyLabel="미지정" />
              </>
            ) : (
              <span className="roster-empty">—</span>
            )}
          </div>
        ))}

        <div className="roster-row-label roster-row-night">야간</div>
        {days.map((day) => (
          <div key={`${day.dateIso}-night`} className={`roster-cell roster-row-night${day.isToday ? ' is-today' : ''}`}>
            {day.hasShiftTeams ? (
              <>
                <span className="roster-team">{day.nightTeams.join('·')}</span>
                <NameList names={day.nightMembers} emptyLabel="미지정" />
              </>
            ) : (
              <span className="roster-empty">—</span>
            )}
          </div>
        ))}

        <div className="roster-row-label roster-row-vacation">휴가</div>
        {days.map((day) => (
          <div key={`${day.dateIso}-vac`} className={`roster-cell roster-row-vacation${day.isToday ? ' is-today' : ''}`}>
            {day.vacations.length === 0 ? (
              <span className="roster-empty">—</span>
            ) : (
              day.vacations.map((vacation) => (
                <span key={vacation.name} className="roster-name roster-name-vacation">
                  {vacation.name}
                  {vacation.type ? <small>{vacation.type}</small> : null}
                </span>
              ))
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * 2주간 근무자 이름만 크게 보여주는 전체 화면 오버레이.
 * 손날 스와이프 또는 타이틀바 "근무표" 버튼으로 열고 닫습니다. Esc로도 닫힙니다.
 */
export function ShiftRosterOverlay({ open, days, onClose }: ShiftRosterOverlayProps) {
  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  const firstWeek = days.slice(0, 7)
  const secondWeek = days.slice(7, 14)
  const lastDay = secondWeek[secondWeek.length - 1] ?? firstWeek[firstWeek.length - 1]

  return (
    <div className="roster-overlay" role="region" aria-label="2주 근무표">
      <header className="roster-header">
        <h2>근무표</h2>
        <p className="roster-range">
          {firstWeek[0]?.dayLabel} ~ {lastDay?.dayLabel}
        </p>
        <button type="button" className="ghost-button roster-close" onClick={onClose}>
          캘린더로 (Esc)
        </button>
      </header>
      <div className="roster-body">
        <RosterWeek days={firstWeek} title="이번 주" />
        {secondWeek.length > 0 ? <RosterWeek days={secondWeek} title="다음 주" /> : null}
      </div>
    </div>
  )
}
