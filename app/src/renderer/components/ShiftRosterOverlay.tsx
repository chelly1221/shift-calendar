import { useEffect } from 'react'

export interface RosterMember {
  name: string
  absence: { kind: '휴가' | '교육'; label: string; partial: boolean } | null
}

export interface ShiftRosterDay {
  dateIso: string
  dayLabel: string
  weekdayLabel: string
  isToday: boolean
  isWeekend: boolean
  holidayName: string | null
  dayTeams: string[]
  nightTeams: string[]
  dayRoster: RosterMember[]
  nightRoster: RosterMember[]
  dayWorkerRoster: RosterMember[]
  hideDayWorkers: boolean
  hasShiftTeams: boolean
}

interface ShiftRosterOverlayProps {
  open: boolean
  days: ShiftRosterDay[]
  onClose: () => void
}

function MemberList({ members, emptyLabel }: { members: RosterMember[]; emptyLabel: string }) {
  if (members.length === 0) {
    return <span className="roster-empty">{emptyLabel}</span>
  }
  return (
    <>
      {members.map((member) => {
        const absence = member.absence
        const struck = Boolean(absence && !absence.partial)
        return (
          <span
            key={member.name}
            className={`roster-member${struck ? ' is-absent' : ''}${absence?.partial ? ' is-partial' : ''}`}
          >
            <span className="roster-name">{member.name}</span>
            {absence ? (
              <span className={`roster-badge roster-badge-${absence.kind === '교육' ? 'education' : 'vacation'}`}>
                {absence.label}
              </span>
            ) : null}
          </span>
        )
      })}
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
            {day.hideDayWorkers ? <span className="roster-empty">—</span> : <MemberList members={day.dayWorkerRoster} emptyLabel="—" />}
          </div>
        ))}

        <div className="roster-row-label roster-row-day">주간</div>
        {days.map((day) => (
          <div key={`${day.dateIso}-day`} className={`roster-cell roster-row-day${day.isToday ? ' is-today' : ''}`}>
            {day.hasShiftTeams ? (
              <>
                <span className="roster-team">{day.dayTeams.join('·')}</span>
                <MemberList members={day.dayRoster} emptyLabel="미지정" />
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
                <MemberList members={day.nightRoster} emptyLabel="미지정" />
              </>
            ) : (
              <span className="roster-empty">—</span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * 2주간 근무자 이름만 크게 보여주는 전체 화면 오버레이.
 * 손 자세(손바닥 → 열기, 주먹 → 닫기)로만 전환합니다. Esc는 비상용 닫기.
 * 휴가/교육자는 명단에서 빼지 않고 삭선 + 뱃지로 표시합니다 (시간차 휴가는 뱃지만).
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
        <p className="roster-gesture-hint">✊ 주먹을 쥐면 캘린더로 돌아갑니다</p>
      </header>
      <div className="roster-body">
        <RosterWeek days={firstWeek} title="이번 주" />
        {secondWeek.length > 0 ? <RosterWeek days={secondWeek} title="다음 주" /> : null}
      </div>
    </div>
  )
}
