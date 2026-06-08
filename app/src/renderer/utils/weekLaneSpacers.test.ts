import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { buildLaneSpacers, laneBandForType, type LaneEventInput, type LaneSpacer } from './weekLaneSpacers'

/** 로컬 날짜/시각 → UTC ISO. TZ 와 무관하게 toLocal() 이 다시 같은 로컬 날짜로 돌아오게 한다. */
function localUtc(year: number, month: number, day: number, hour = 9, minute = 0): string {
  return DateTime.local(year, month, day, hour, minute).toUTC().toISO() as string
}

let counter = 0
function ev(eventType: string, startAtUtc: string, endAtUtc: string): LaneEventInput {
  counter += 1
  return { localId: `e${counter}`, eventType, startAtUtc, endAtUtc }
}

/** 단일 날짜(하루)짜리 이벤트. */
function singleDay(eventType: string, y: number, m: number, d: number): LaneEventInput {
  return ev(eventType, localUtc(y, m, d, 9), localUtc(y, m, d, 10))
}

function key(spacer: LaneSpacer): string {
  return `${spacer.dateIso}|${spacer.bandKey}|${spacer.seq}`
}

function keys(spacers: LaneSpacer[]): string[] {
  return spacers.map(key).sort()
}

// 테스트용 한 주 그리드: 2026-06-07(일) ~ 2026-06-14(배타) = 6/7..6/13
const GRID_START = '2026-06-07'
const GRID_END = '2026-06-14'

describe('laneBandForType', () => {
  it('타입별 밴드 인덱스를 우선순위 순서로 반환한다', () => {
    expect(laneBandForType('운용중지작업')).toBe(0)
    expect(laneBandForType('중요')).toBe(1)
    expect(laneBandForType('일반')).toBe(2)
    expect(laneBandForType('반복업무')).toBe(3)
    expect(laneBandForType('교육')).toBe(4)
    expect(laneBandForType('휴가')).toBe(5)
    expect(laneBandForType('출장')).toBe(6)
  })

  it('정렬 대상이 아닌/미지 타입은 null (→ 호출부에서 맨 아래 밴드로 보냄)', () => {
    expect(laneBandForType('근무')).toBeNull()
    expect(laneBandForType('공휴일')).toBeNull()
    // 레거시/외부 동기화로 들어올 수 있는 미지 타입: 운용중지(밴드 0)와 겹치면 안 되므로 null 이어야 한다.
    expect(laneBandForType('기념일')).toBeNull()
    expect(laneBandForType('무언가커스텀')).toBeNull()
  })
})

describe('buildLaneSpacers', () => {
  it('grid 범위가 없으면 빈 배열', () => {
    expect(buildLaneSpacers([singleDay('일반', 2026, 6, 8)], null, null)).toEqual([])
    expect(buildLaneSpacers([singleDay('일반', 2026, 6, 8)], GRID_START, null)).toEqual([])
  })

  it('같은 타입을 같은 레인에 맞추도록 위쪽 빈 밴드를 채운다', () => {
    const events = [
      singleDay('운용중지작업', 2026, 6, 8),
      singleDay('일반', 2026, 6, 8),
      singleDay('교육', 2026, 6, 8),
      singleDay('일반', 2026, 6, 9),
      singleDay('교육', 2026, 6, 9),
      singleDay('교육', 2026, 6, 10),
    ]
    const spacers = buildLaneSpacers(events, GRID_START, GRID_END)
    // 6/8: 운중+일반+교육 모두 있음 → 스페이서 0
    // 6/9: 운중 없음 → maint 스페이서 1 (일반/교육은 있음)
    // 6/10: 운중+일반 없음 → maint 1 + basic 1
    expect(keys(spacers)).toEqual(
      keys([
        { id: '', dateIso: '2026-06-09', bandKey: 'maint', laneBand: 0, seq: 0 },
        { id: '', dateIso: '2026-06-10', bandKey: 'maint', laneBand: 0, seq: 0 },
        { id: '', dateIso: '2026-06-10', bandKey: 'basic', laneBand: 2, seq: 0 },
      ]),
    )
  })

  it('가장 깊은 밴드보다 아래는 채우지 않아 희소한 날은 짧게 유지된다', () => {
    const events = [
      singleDay('일반', 2026, 6, 8), // 월: 일반만
      singleDay('휴가', 2026, 6, 9), // 화: 휴가만
    ]
    const spacers = buildLaneSpacers(events, GRID_START, GRID_END)
    // 6/8: deepest=일반 → 위쪽(운중/중요) laneCount 0 → 스페이서 없음(휴가 레인은 아래라 예약 안 함)
    // 6/9: deepest=휴가 → 위쪽 중 laneCount>0 인 건 일반(=1) → basic 스페이서 1
    expect(keys(spacers)).toEqual(keys([{ id: '', dateIso: '2026-06-09', bandKey: 'basic', laneBand: 2, seq: 0 }]))
  })

  it('멀티데이 이벤트는 걸친 모든 날의 위쪽 밴드를 채워 열 간 정렬을 보장한다', () => {
    const events = [
      // 휴가: 6/8 ~ 6/10 (종료 6/11 자정 → 6/8,6/9,6/10 포함)
      ev('휴가', localUtc(2026, 6, 8, 9), localUtc(2026, 6, 11, 0)),
      singleDay('일반', 2026, 6, 9), // 화에만 일반
    ]
    const spacers = buildLaneSpacers(events, GRID_START, GRID_END)
    // laneCount: basic=1, vac=1
    // 6/8: deepest=휴가 → basic 스페이서 1
    // 6/9: 일반 있음 → basic need 0
    // 6/10: deepest=휴가 → basic 스페이서 1
    expect(keys(spacers)).toEqual(
      keys([
        { id: '', dateIso: '2026-06-08', bandKey: 'basic', laneBand: 2, seq: 0 },
        { id: '', dateIso: '2026-06-10', bandKey: 'basic', laneBand: 2, seq: 0 },
      ]),
    )
  })

  it('균형 모드: 한 날에 같은 타입이 여러 개여도 다른 날에 추가 레인을 강요하지 않는다 (cap=1)', () => {
    const events = [
      singleDay('일반', 2026, 6, 8),
      singleDay('일반', 2026, 6, 8), // 월: 일반 2개
      singleDay('일반', 2026, 6, 9),
      singleDay('교육', 2026, 6, 9), // 화: 일반 1 + 교육 1
    ]
    const spacers = buildLaneSpacers(events, GRID_START, GRID_END)
    // cap=1 → laneCount: basic=1, edu=1
    // 6/8: deepest=일반 → 위쪽 없음 → 0
    // 6/9: deepest=교육 → basic need = 1-1 = 0 → 스페이서 없음 (월의 2번째 일반 때문에 빈칸 만들지 않음)
    expect(spacers).toEqual([])
  })

  it('균형 모드: 한 날에 위쪽 타입이 2개여도 아래 타입 정렬용 스페이서는 1개만(바쁜 날은 그 날만 어긋남)', () => {
    const events = [
      singleDay('일반', 2026, 6, 8),
      singleDay('일반', 2026, 6, 8),
      singleDay('교육', 2026, 6, 8), // 월: 일반 2 + 교육 1
      singleDay('교육', 2026, 6, 9), // 화: 교육 1
    ]
    const spacers = buildLaneSpacers(events, GRID_START, GRID_END)
    // cap=1 → laneCount: basic=1, edu=1
    // 6/8: deepest=교육 → basic need = 1-2 = 음수 → 0 (일반 2개는 그대로 쌓임, 교육은 그 날만 아래로)
    // 6/9: deepest=교육 → basic need = 1-0 = 1 → basic 스페이서 1개
    expect(keys(spacers)).toEqual(keys([{ id: '', dateIso: '2026-06-09', bandKey: 'basic', laneBand: 2, seq: 0 }]))
  })

  it('이벤트가 없는 주는 스페이서를 만들지 않는다', () => {
    expect(buildLaneSpacers([], GRID_START, GRID_END)).toEqual([])
  })

  it('스페이서 id 는 __spacer:: 접두사로 실제 이벤트와 충돌하지 않는다', () => {
    const spacers = buildLaneSpacers(
      [singleDay('일반', 2026, 6, 8), singleDay('휴가', 2026, 6, 9)],
      GRID_START,
      GRID_END,
    )
    expect(spacers.length).toBeGreaterThan(0)
    for (const spacer of spacers) {
      expect(spacer.id.startsWith('__spacer::')).toBe(true)
    }
  })
})
