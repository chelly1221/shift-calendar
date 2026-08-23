import { useEffect, useLayoutEffect, useRef } from 'react'

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
        {/* 일자·일근·주간·야간 4칸을 하나의 굵은 테두리로 묶는 열 프레임 (셀 뒤에 깔림) */}
        {days.map((day, index) => (
          <div
            key={`${day.dateIso}-frame`}
            className={`roster-day-frame${day.isToday ? ' is-today' : ''}${day.isWeekend || day.holidayName ? ' is-offday' : ''}`}
            style={{ gridColumn: index + 2, gridRow: '1 / span 4' }}
            aria-hidden="true"
          />
        ))}
        {/* 프레임이 칸을 점유하므로 나머지 셀도 모두 명시 배치 (자동 배치면 프레임을 피해 밀려남) */}
        <div className="roster-corner" style={{ gridColumn: 1, gridRow: 1 }}>{title}</div>
        {days.map((day, index) => (
          <div
            key={day.dateIso}
            className={`roster-day-header${day.isToday ? ' is-today' : ''}${day.isWeekend || day.holidayName ? ' is-offday' : ''}`}
            style={{ gridColumn: index + 2, gridRow: 1 }}
          >
            <span className="roster-day-date">{day.dayLabel}</span>
            <span className="roster-day-weekday">{day.holidayName ?? day.weekdayLabel}</span>
          </div>
        ))}

        <div className="roster-row-label roster-row-dayworker" style={{ gridColumn: 1, gridRow: 2 }}>일근</div>
        {days.map((day, index) => (
          <div
            key={`${day.dateIso}-dw`}
            className={`roster-cell roster-row-dayworker${day.isToday ? ' is-today' : ''}`}
            style={{ gridColumn: index + 2, gridRow: 2 }}
          >
            <div className="roster-cell-inner">
              {day.hideDayWorkers ? <span className="roster-empty">—</span> : <MemberList members={day.dayWorkerRoster} emptyLabel="—" />}
            </div>
          </div>
        ))}

        <div className="roster-row-label roster-row-day" style={{ gridColumn: 1, gridRow: 3 }}>주간</div>
        {days.map((day, index) => (
          <div
            key={`${day.dateIso}-day`}
            className={`roster-cell roster-row-day${day.isToday ? ' is-today' : ''}`}
            style={{ gridColumn: index + 2, gridRow: 3 }}
          >
            {day.hasShiftTeams ? <span className="roster-team">{day.dayTeams.join('·')}</span> : null}
            <div className="roster-cell-inner">
              {day.hasShiftTeams ? <MemberList members={day.dayRoster} emptyLabel="미지정" /> : <span className="roster-empty">—</span>}
            </div>
          </div>
        ))}

        <div className="roster-row-label roster-row-night" style={{ gridColumn: 1, gridRow: 4 }}>야간</div>
        {days.map((day, index) => (
          <div
            key={`${day.dateIso}-night`}
            className={`roster-cell roster-row-night${day.isToday ? ' is-today' : ''}`}
            style={{ gridColumn: index + 2, gridRow: 4 }}
          >
            {day.hasShiftTeams ? <span className="roster-team">{day.nightTeams.join('·')}</span> : null}
            <div className="roster-cell-inner">
              {day.hasShiftTeams ? <MemberList members={day.nightRoster} emptyLabel="미지정" /> : <span className="roster-empty">—</span>}
            </div>
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
const MIN_ROSTER_FONT_PX = 12
const MAX_ROSTER_FONT_PX = 200

/**
 * 모든 셀이 넘치지 않는 가장 큰 폰트 크기를 이진탐색으로 찾아 --roster-font 에 적용합니다.
 * 셀 크기는 그리드(1fr)로 정해지므로 폰트 ↑ → 넘침 ↑ 단조성이 성립합니다.
 */
function fitRosterFont(body: HTMLElement): void {
  const cells = Array.from(body.querySelectorAll<HTMLElement>('.roster-cell'))
  if (cells.length === 0) return
  const overflows = (px: number): boolean => {
    body.style.setProperty('--roster-font', `${px}px`)
    for (const cell of cells) {
      const inner = cell.querySelector<HTMLElement>('.roster-cell-inner')
      if (!inner) continue
      const style = getComputedStyle(cell)
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      if (inner.scrollHeight > cell.clientHeight - padY + 0.5) return true
      if (inner.scrollWidth > cell.clientWidth - padX + 0.5) return true
    }
    return false
  }
  let lo = MIN_ROSTER_FONT_PX
  let hi = MAX_ROSTER_FONT_PX
  if (overflows(lo)) {
    body.style.setProperty('--roster-font', `${lo}px`)
    return
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (overflows(mid)) hi = mid
    else lo = mid
  }
  body.style.setProperty('--roster-font', `${lo}px`)
}

export function ShiftRosterOverlay({ open, days, onClose }: ShiftRosterOverlayProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const body = bodyRef.current
    if (!body) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitRosterFont(body))
    }
    fitRosterFont(body)
    const observer = new ResizeObserver(schedule)
    observer.observe(body)
    // 폰트 로딩 완료 후 글자 폭이 바뀔 수 있으므로 한 번 더
    void document.fonts?.ready.then(schedule)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [open, days])

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

  // 상단 제목줄은 두지 않음 — 날짜는 열 머리에 있고, 세로 공간은 전부 이름·일자 폰트에 씁니다.
  return (
    <div className="roster-overlay" role="region" aria-label="2주 근무표">
      <div className="roster-body" ref={bodyRef}>
        <RosterWeek days={firstWeek} title="이번 주" />
        {secondWeek.length > 0 ? <RosterWeek days={secondWeek} title="다음 주" /> : null}
      </div>
    </div>
  )
}
