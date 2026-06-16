import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { buildLaneLayout, laneBandForType, type LaneEventInput, type LaneSpacer } from './weekLaneSpacers'

/** 로컬 날짜/시각 → UTC ISO. TZ 와 무관하게 toLocal() 이 다시 같은 로컬 날짜로 돌아오게 한다. */
function localUtc(year: number, month: number, day: number, hour = 9, minute = 0): string {
  return DateTime.local(year, month, day, hour, minute).toUTC().toISO() as string
}

let counter = 0
function ev(eventType: string, startAtUtc: string, endAtUtc: string, localId?: string): LaneEventInput {
  counter += 1
  return { localId: localId ?? `e${counter}`, eventType, startAtUtc, endAtUtc }
}

/** 단일 날짜(하루)짜리 이벤트. */
function singleDay(eventType: string, y: number, m: number, d: number, localId?: string): LaneEventInput {
  return ev(eventType, localUtc(y, m, d, 9), localUtc(y, m, d, 10), localId)
}

/** 스페이서를 정렬 가능한 키로: 날짜|높이클래스|laneOrder|seq. */
function spacerKey(spacer: LaneSpacer): string {
  return `${spacer.dateIso}|${spacer.heightKey}|${spacer.laneOrder}|${spacer.seq}`
}

function spacerKeys(spacers: LaneSpacer[]): string[] {
  return spacers.map(spacerKey).sort()
}

// 테스트용 한 주 그리드: 2026-06-07(일) ~ 2026-06-14(배타) = 6/7..6/13
const GRID_START = '2026-06-07'
const GRID_END = '2026-06-14'

describe('laneBandForType', () => {
  it('타입별 밴드 인덱스를 우선순위 순서로 반환한다(휴가·교육 최상단, 출장 최하단)', () => {
    expect(laneBandForType('휴가')).toBe(0)
    expect(laneBandForType('교육')).toBe(1)
    expect(laneBandForType('운용중지작업')).toBe(2)
    expect(laneBandForType('중요')).toBe(3)
    expect(laneBandForType('일반')).toBe(4)
    expect(laneBandForType('반복업무')).toBe(5)
    expect(laneBandForType('출장')).toBe(6)
  })

  it('정렬 대상이 아닌/미지 타입은 null', () => {
    expect(laneBandForType('근무')).toBeNull()
    expect(laneBandForType('공휴일')).toBeNull()
    expect(laneBandForType('기념일')).toBeNull()
  })
})

describe('buildLaneLayout', () => {
  it('grid 범위가 없으면 빈 결과', () => {
    const layout = buildLaneLayout([singleDay('일반', 2026, 6, 8)], null, null)
    expect(layout.spacers).toEqual([])
    expect(layout.laneOrderByLocalId.size).toBe(0)
  })

  it('이벤트가 없는 주는 스페이서를 만들지 않는다', () => {
    const layout = buildLaneLayout([], GRID_START, GRID_END)
    expect(layout.spacers).toEqual([])
  })

  it('같은 타입을 같은 레인에 맞추도록 사이의 빈 밴드를 채운다(겹치는 타입은 분리)', () => {
    // 교육(풀0)=V0 최상단, 운용중지(풀1)=V1, 일반(풀1)=V2. 운중·일반은 6/8 에 겹쳐 분리.
    const events = [
      singleDay('운용중지작업', 2026, 6, 8),
      singleDay('일반', 2026, 6, 8),
      singleDay('교육', 2026, 6, 8),
      singleDay('일반', 2026, 6, 9),
      singleDay('교육', 2026, 6, 9),
      singleDay('교육', 2026, 6, 10),
    ]
    const { spacers } = buildLaneLayout(events, GRID_START, GRID_END)
    // 6/8: 셋 다 점유 → 채움 없음 / 6/9: 일반(V2) 위 운중(V1)이 비어 1칸 채움 / 6/10: 교육(V0)이 최상단 → 위 없음
    expect(spacerKeys(spacers)).toEqual(
      spacerKeys([{ id: '', dateIso: '2026-06-09', heightKey: 'text', laneOrder: 1, seq: 0 }]),
    )
  })

  it('겹치지 않는 같은 높이(text) 타입은 한 레인을 공유한다 (운용중지 월 + 중요 화)', () => {
    const events = [
      singleDay('운용중지작업', 2026, 6, 8, 'maint'),
      singleDay('중요', 2026, 6, 9, 'imp'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 서로 다른 날 → 한 가상 밴드(0) 공유 → 스페이서 없음, 둘 다 lane 0
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('maint')).toBe(0)
    expect(laneOrderByLocalId.get('imp')).toBe(0)
  })

  it('같은 날 겹치는 같은 높이 타입은 공유하지 않고 따로 쌓인다', () => {
    const events = [
      singleDay('운용중지작업', 2026, 6, 8, 'maint'),
      singleDay('중요', 2026, 6, 8, 'imp'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('maint')).toBe(0)
    expect(laneOrderByLocalId.get('imp')).toBe(1)
  })

  it('교육과 휴가(둘 다 22px)도 겹치지 않으면 한 레인을 공유한다', () => {
    const events = [
      singleDay('교육', 2026, 6, 8, 'edu'),
      singleDay('휴가', 2026, 6, 9, 'vac'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('edu')).toBe(0)
    expect(laneOrderByLocalId.get('vac')).toBe(0)
  })

  it('다른 풀(교육 vs 일반)은 겹치지 않아도 레인을 공유하지 않는다', () => {
    const events = [
      singleDay('일반', 2026, 6, 8, 'basic'),
      singleDay('교육', 2026, 6, 9, 'edu'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 교육(풀0)=밴드0 최상단, 일반(풀1)=밴드1. 6/8 에 일반을 lane1 로 내리려면 위 교육(short) 레인 1칸을 채운다.
    expect(spacerKeys(spacers)).toEqual(
      spacerKeys([{ id: '', dateIso: '2026-06-08', heightKey: 'short', laneOrder: 0, seq: 0 }]),
    )
    expect(laneOrderByLocalId.get('edu')).toBe(0)
    expect(laneOrderByLocalId.get('basic')).toBe(1)
  })

  it('가상 밴드 예약은 하루 최대 점유 수만큼(한 타입이 2개면 2칸) + 공유', () => {
    // 일반 2(월) + 중요 1(화) → 둘은 겹치지 않아 한 가상 밴드(0), laneCount=2.
    const events = [
      singleDay('일반', 2026, 6, 8, 'b1'),
      singleDay('일반', 2026, 6, 8, 'b2'),
      singleDay('중요', 2026, 6, 9, 'imp'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 가상 밴드 0 이 가장 깊어 아래 패딩 없음 → 스페이서 없음. 모두 lane 0 에서 시작.
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('b1')).toBe(0)
    expect(laneOrderByLocalId.get('b2')).toBe(0)
    expect(laneOrderByLocalId.get('imp')).toBe(0)
  })

  it('상위 가상 밴드가 max 예약(2)이면 아래 풀 타입은 모든 날 같은 레인에서 시작한다', () => {
    // 일반 2(월) + 일반 1·출장 1(화). 일반=text 밴드(lc2), 출장=아래 풀(short).
    const events = [
      singleDay('일반', 2026, 6, 8, 'b1'),
      singleDay('일반', 2026, 6, 8, 'b2'),
      singleDay('일반', 2026, 6, 9, 'b3'),
      singleDay('출장', 2026, 6, 9, 'trip'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 6/9: 일반 1개라 예약 2칸 중 1칸을 text 스페이서(seq1)로 채워 출장을 lane2 로 → 출장 항상 일반 블록 아래.
    expect(spacerKeys(spacers)).toEqual(
      spacerKeys([{ id: '', dateIso: '2026-06-09', heightKey: 'text', laneOrder: 0, seq: 1 }]),
    )
    expect(laneOrderByLocalId.get('trip')).toBe(1)
  })

  it('겹치는 타입과 겹치지 않는 타입이 섞여도 최소 레인으로 패킹한다', () => {
    // 운용중지(월)+일반(월) 겹침 / 중요(화) 는 둘과 안 겹침.
    const events = [
      singleDay('운용중지작업', 2026, 6, 8, 'maint'),
      singleDay('일반', 2026, 6, 8, 'basic'),
      singleDay('중요', 2026, 6, 9, 'imp'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 운중→밴드0, 중요→밴드0(운중과 안 겹침 공유), 일반→밴드1(운중과 겹침). 총 2레인.
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('maint')).toBe(0)
    expect(laneOrderByLocalId.get('imp')).toBe(0)
    expect(laneOrderByLocalId.get('basic')).toBe(1)
  })

  it('휴가·교육은 text 타입보다 위(최상단), 출장은 아래(최하단) 레인에 배치된다', () => {
    // 한 날에 휴가·교육·일반·출장이 모두 있으면 세로 순서: 휴가(0) → 교육(1) → 일반(2) → 출장(3).
    const events = [
      singleDay('휴가', 2026, 6, 8, 'vac'),
      singleDay('교육', 2026, 6, 8, 'edu'),
      singleDay('일반', 2026, 6, 8, 'basic'),
      singleDay('출장', 2026, 6, 8, 'trip'),
    ]
    const { laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    expect(laneOrderByLocalId.get('vac')).toBe(0)
    expect(laneOrderByLocalId.get('edu')).toBe(1)
    expect(laneOrderByLocalId.get('basic')).toBe(2)
    expect(laneOrderByLocalId.get('trip')).toBe(3)
  })

  it('휴가(최상단 풀) 멀티데이는 다른 타입이 없는 날에도 항상 lane 0 에서 시작한다', () => {
    const events = [
      // 휴가: 6/8 ~ 6/10 (종료 6/11 자정 → 6/8,6/9,6/10 포함). 휴가는 최상단 풀이라 위에 채울 밴드가 없다.
      ev('휴가', localUtc(2026, 6, 8, 9), localUtc(2026, 6, 11, 0), 'vac'),
      singleDay('일반', 2026, 6, 9, 'basic'), // 화에만 일반(text, 아래 밴드)
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 휴가=밴드0(최상단), 일반=밴드1. 휴가 위에는 밴드가 없어 스페이서가 필요 없다.
    // 6/9 의 일반은 그 위 휴가(점유)와 같은 폭이라 채움 0 → 스페이서 전혀 없음.
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('vac')).toBe(0)
    expect(laneOrderByLocalId.get('basic')).toBe(1)
  })

  it('멀티데이(아래 풀) 이벤트도 걸친 모든 날에서 같은 레인에 맞춰 정렬된다', () => {
    const events = [
      // 출장: 6/8 ~ 6/10 (종료 6/11 자정 → 6/8,6/9,6/10 포함). 출장은 최하단 풀.
      ev('출장', localUtc(2026, 6, 8, 9), localUtc(2026, 6, 11, 0), 'trip'),
      singleDay('일반', 2026, 6, 9, 'basic'), // 화에만 일반(text, 위 밴드)
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    // 일반=text 밴드0, 출장=아래 풀 밴드1. 6/8·6/10 은 일반이 없어 text 스페이서로 출장을 lane1 에 맞춘다.
    expect(spacerKeys(spacers)).toEqual(
      spacerKeys([
        { id: '', dateIso: '2026-06-08', heightKey: 'text', laneOrder: 0, seq: 0 },
        { id: '', dateIso: '2026-06-10', heightKey: 'text', laneOrder: 0, seq: 0 },
      ]),
    )
    expect(laneOrderByLocalId.get('trip')).toBe(1)
    expect(laneOrderByLocalId.get('basic')).toBe(0)
  })

  it('우선순위 역전: 낮은 우선순위 타입이 더 위 레인에 올 수 있어 laneOrder(가상 밴드 인덱스)로 정렬해야 한다', () => {
    // 운용중지·중요는 6/8 에 겹침 → V0(운중), V1(중요). 일반(6/9)은 운중과 안 겹쳐 V0 공유.
    // 타입 우선순위는 중요(1) < 일반(2) 이지만, 실제 세로(laneOrder)는 일반=0 < 중요=1 로 역전된다.
    // 타입 인덱스로 정렬하면 이 배치가 깨지므로 laneOrder 로 정렬해야 한다.
    const events = [
      singleDay('운용중지작업', 2026, 6, 8, 'maint'),
      singleDay('중요', 2026, 6, 8, 'imp'),
      singleDay('일반', 2026, 6, 9, 'basic'),
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('maint')).toBe(0)
    expect(laneOrderByLocalId.get('basic')).toBe(0)
    expect(laneOrderByLocalId.get('imp')).toBe(1)
  })

  it('같은 날 겹치는 같은 높이 타입 3개는 3개의 가상 밴드로 분리된다(다른 날 타입은 공유)', () => {
    const events = [
      singleDay('운용중지작업', 2026, 6, 8, 'm'),
      singleDay('중요', 2026, 6, 8, 'i'),
      singleDay('일반', 2026, 6, 8, 'b'),
      singleDay('반복업무', 2026, 6, 9, 'r'), // 6/9 → 운중(V0)과 안 겹쳐 V0 공유
    ]
    const { laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    expect(laneOrderByLocalId.get('m')).toBe(0)
    expect(laneOrderByLocalId.get('i')).toBe(1)
    expect(laneOrderByLocalId.get('b')).toBe(2)
    expect(laneOrderByLocalId.get('r')).toBe(0)
  })

  it('미지 타입(레인 대상 아님)은 패킹에서 제외 → laneOrder 없음, 스페이서도 안 만든다', () => {
    const events = [
      singleDay('일반', 2026, 6, 8, 'basic'),
      singleDay('기념일', 2026, 6, 8, 'misc'), // laneBandForType → null
    ]
    const { spacers, laneOrderByLocalId } = buildLaneLayout(events, GRID_START, GRID_END)
    expect(spacers).toEqual([])
    expect(laneOrderByLocalId.get('basic')).toBe(0)
    expect(laneOrderByLocalId.has('misc')).toBe(false)
  })

  it('스페이서 id 는 __spacer:: 접두사로 실제 이벤트와 충돌하지 않는다', () => {
    const { spacers } = buildLaneLayout(
      [singleDay('일반', 2026, 6, 8), singleDay('교육', 2026, 6, 9)],
      GRID_START,
      GRID_END,
    )
    expect(spacers.length).toBeGreaterThan(0)
    for (const spacer of spacers) {
      expect(spacer.id.startsWith('__spacer::')).toBe(true)
    }
  })
})
