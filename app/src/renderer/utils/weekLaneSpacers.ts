import { DateTime } from 'luxon'

/**
 * 같은 주(week row) 안에서 같은 타입을 같은 세로 위치(레인)에 맞추되,
 * "같은 높이이고 같은 날에 겹치지 않는 다른 타입"끼리는 한 레인을 공유해 전체 높이를 줄이는
 * 레인 레이아웃 계산 로직.
 *
 * 동작(가상 밴드 + 최대 점유 예약):
 * 1) 타입을 같은 픽셀 높이끼리 풀로 묶는다. text(24px)={운용중지·중요·일반·반복업무}, short(22px)={교육·휴가·출장}.
 * 2) 각 풀 안에서, "그 주에 서로 겹치는(같은 날 둘 다 등장하는) 날이 없는" 타입들을 하나의 가상 밴드(그룹)로 묶는다.
 *    (그리디 first-fit 컬러링 → 가상 밴드 수 = 그 풀에서 한 날에 동시에 등장하는 타입 최대 수.)
 * 3) 가상 밴드를 위→아래 순서로 쌓고, 가상 밴드별 예약 레인 수 = 그 주 "하루 최대 점유 수"로 잡는다.
 *    한 가상 밴드에 묶인 타입들은 서로 다른 날에만 나오므로, 어느 날이든 그 가상 밴드의 시작 레인에서 시작한다
 *    → 같은 타입은 항상 같은 세로 위치, 겹치지 않는 다른 타입은 같은 레인을 공유(컴팩트).
 * 4) 각 날짜에서, 그 날 가장 깊은(아래) 가상 밴드보다 "위에 있는" 밴드를 예약 수까지 투명 스페이서로 채운다.
 *    (아래쪽은 채우지 않아 희소한 날은 짧게 유지.)
 *
 * 실제 이벤트의 세로 정렬은 타입 인덱스가 아니라 "그 주에 배정된 가상 밴드 인덱스"(laneOrder)로 정해진다.
 * (레인 공유가 일어나면 타입 우선순위 순서 ≠ 실제 세로 순서가 될 수 있어, 가상 밴드 인덱스로 정렬해야 한다.)
 */

export interface LaneEventInput {
  localId: string
  eventType: string
  /** UTC ISO. */
  startAtUtc: string
  /** UTC ISO. */
  endAtUtc: string
}

export type LaneHeightKey = 'text' | 'short'

export interface LaneSpacer {
  /** FullCalendar event id. `__spacer::` 접두사로 실제 이벤트 store 와 절대 충돌하지 않는다. */
  id: string
  /** 로컬 날짜 (YYYY-MM-DD). all-day 이벤트로 이 셀에 렌더된다. */
  dateIso: string
  /** 스페이서 높이 클래스(=레인 높이). text=24px, short=22px. */
  heightKey: LaneHeightKey
  /** 정렬 키 = 그 주에 이 스페이서가 채우는 가상 밴드 인덱스. */
  laneOrder: number
  /** 같은 (날짜, 가상 밴드) 안에서 스페이서 정렬/식별용 일련번호. */
  seq: number
}

export interface LaneLayout {
  spacers: LaneSpacer[]
  /**
   * 실제 이벤트의 정렬 키. key = event.localId → 그 이벤트가 배정된 가상 밴드 인덱스(laneOrder).
   * 멀티데이는 첫 번째 가시(그리드 내) 날짜가 속한 주의 배정을 쓴다.
   */
  laneOrderByLocalId: Map<string, number>
}

/**
 * 위(top) → 아래(bottom) 우선순위 순서의 타입 밴드 정의. 타입 하나당 밴드 하나.
 * heightKey 가 같은(=같은 픽셀 높이) 밴드끼리만 레인을 공유할 수 있다.
 * 풀(heightKey) 순서는 HEIGHT_ORDER 로 결정한다(text 풀이 위, short 풀이 아래).
 */
export const LANE_BANDS: ReadonlyArray<{ key: string; type: string; heightKey: LaneHeightKey }> = [
  { key: 'maint', type: '운용중지작업', heightKey: 'text' },
  { key: 'important', type: '중요', heightKey: 'text' },
  { key: 'basic', type: '일반', heightKey: 'text' },
  { key: 'routine', type: '반복업무', heightKey: 'text' },
  { key: 'edu', type: '교육', heightKey: 'short' },
  { key: 'vac', type: '휴가', heightKey: 'short' },
  { key: 'trip', type: '출장', heightKey: 'short' },
]

/** 가상 밴드를 쌓는 풀(높이 클래스) 순서: text(24px) 가 위, short(22px) 가 아래. */
const HEIGHT_ORDER: ReadonlyArray<LaneHeightKey> = ['text', 'short']

const BAND_INDEX_BY_TYPE = new Map(LANE_BANDS.map((band, index) => [band.type, index] as const))

/** 이벤트 타입의 밴드 인덱스(=laneBand). 정렬 대상이 아닌 타입(근무/공휴일 등)은 null. */
export function laneBandForType(eventType: string): number | null {
  const index = BAND_INDEX_BY_TYPE.get(eventType)
  return index === undefined ? null : index
}

/** 이벤트가 점유하는 로컬 날짜(YYYY-MM-DD) 목록. 멀티데이는 포함된 모든 날을 반환한다. */
function coveredDates(event: LaneEventInput): string[] {
  const startLocal = DateTime.fromISO(event.startAtUtc).toLocal()
  if (!startLocal.isValid) return []
  const startDay = startLocal.startOf('day')

  const endLocal = DateTime.fromISO(event.endAtUtc).toLocal()
  // 종료가 정확히 자정(ms 포함)이면 그 날은 포함되지 않는다(배타적 종료).
  // FullCalendar 의 computeVisibleDayRange(endTimeMS !== 0) 와 일치시키기 위해 millisecond 까지 확인한다.
  const inclusiveEnd =
    endLocal.isValid &&
    endLocal.hour === 0 &&
    endLocal.minute === 0 &&
    endLocal.second === 0 &&
    endLocal.millisecond === 0
      ? endLocal.minus({ days: 1 })
      : endLocal
  let lastDay = (inclusiveEnd.isValid ? inclusiveEnd : startLocal).startOf('day')
  if (lastDay < startDay) lastDay = startDay

  const dates: string[] = []
  for (let cursor = startDay; cursor <= lastDay; cursor = cursor.plus({ days: 1 })) {
    const iso = cursor.toISODate()
    if (iso) dates.push(iso)
  }
  return dates
}

/** 두 날짜 집합이 겹치는 날이 하나도 없으면 true. */
function isDisjoint(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const day of small) {
    if (large.has(day)) return false
  }
  return true
}

interface VirtualBand {
  heightKey: LaneHeightKey
  /** 이 가상 밴드에 묶인 타입 밴드 인덱스들(서로 겹치지 않음). */
  members: number[]
  /** 묶인 타입들이 점유하는 날의 합집합. */
  days: Set<string>
  /** 예약 레인 수 = 멤버들의 하루 최대 점유 수. */
  laneCount: number
}

/**
 * 그리드 가시 범위(gridStartIso 포함 ~ gridEndIso 배타)를 주(7일) 단위로 나눠 레인 레이아웃을 계산한다.
 * gridStart/gridEnd 는 FullCalendar `datesSet` 의 start/end(JSDate)에서 가져온 로컬 날짜 문자열.
 */
export function buildLaneLayout(
  events: LaneEventInput[],
  gridStartIso: string | null,
  gridEndIso: string | null,
): LaneLayout {
  const empty: LaneLayout = { spacers: [], laneOrderByLocalId: new Map() }
  if (!gridStartIso || !gridEndIso) return empty
  const gridStart = DateTime.fromISO(gridStartIso).startOf('day')
  const gridEnd = DateTime.fromISO(gridEndIso).startOf('day') // 배타적
  if (!gridStart.isValid || !gridEnd.isValid || gridEnd <= gridStart) return empty

  // 그리드의 날짜를 순서대로 나열.
  const gridDates: string[] = []
  for (let cursor = gridStart; cursor < gridEnd; cursor = cursor.plus({ days: 1 })) {
    const iso = cursor.toISODate()
    if (iso) gridDates.push(iso)
  }
  const gridDateSet = new Set(gridDates)

  // occupancy[dateIso][band] = 그 날 그 타입의 실제 이벤트 개수.
  const occupancy = new Map<string, number[]>()
  const ensureRow = (dateIso: string): number[] => {
    let row = occupancy.get(dateIso)
    if (!row) {
      row = new Array(LANE_BANDS.length).fill(0)
      occupancy.set(dateIso, row)
    }
    return row
  }
  for (const event of events) {
    const band = laneBandForType(event.eventType)
    if (band === null) continue
    for (const dateIso of coveredDates(event)) {
      if (!gridDateSet.has(dateIso)) continue
      ensureRow(dateIso)[band] += 1
    }
  }

  const spacers: LaneSpacer[] = []
  const laneOrderByDateBand = new Map<string, number>()

  // 7일씩 주(week row) 단위로 처리.
  for (let weekStart = 0; weekStart < gridDates.length; weekStart += 7) {
    const weekDates = gridDates.slice(weekStart, weekStart + 7)

    // 밴드별: 등장 날 집합 + 하루 최대 점유 수.
    const daySet: Set<string>[] = LANE_BANDS.map(() => new Set<string>())
    const bandMax = new Array(LANE_BANDS.length).fill(0)
    for (const dateIso of weekDates) {
      const row = occupancy.get(dateIso)
      if (!row) continue
      for (let band = 0; band < LANE_BANDS.length; band += 1) {
        if (row[band] > 0) {
          daySet[band].add(dateIso)
          if (row[band] > bandMax[band]) bandMax[band] = row[band]
        }
      }
    }

    // 풀(높이 클래스) 순서대로, 겹치지 않는 타입을 가상 밴드로 묶는다(그리디 first-fit, 우선순위 순서).
    const virtualBands: VirtualBand[] = []
    for (const heightKey of HEIGHT_ORDER) {
      for (let band = 0; band < LANE_BANDS.length; band += 1) {
        if (LANE_BANDS[band].heightKey !== heightKey) continue
        if (bandMax[band] <= 0) continue // 이번 주에 없는 타입
        // 이 풀에서 이미 만든 가상 밴드 중, 이 타입과 겹치는 날이 없는 첫 그룹에 합류.
        let group = virtualBands.find(
          (vb) => vb.heightKey === heightKey && isDisjoint(vb.days, daySet[band]),
        )
        if (!group) {
          group = { heightKey, members: [], days: new Set<string>(), laneCount: 0 }
          virtualBands.push(group)
        }
        group.members.push(band)
        for (const day of daySet[band]) group.days.add(day)
        if (bandMax[band] > group.laneCount) group.laneCount = bandMax[band]
      }
    }

    if (virtualBands.length === 0) continue

    // 타입 밴드 → 가상 밴드 인덱스.
    const vbandOfBand = new Array(LANE_BANDS.length).fill(-1)
    virtualBands.forEach((vb, vi) => vb.members.forEach((b) => (vbandOfBand[b] = vi)))
    const laneCountV = virtualBands.map((vb) => vb.laneCount)

    for (const dateIso of weekDates) {
      const row = occupancy.get(dateIso)
      if (!row) continue

      // 이 날 가상 밴드별 점유 수(멤버는 겹치지 않으므로 가상 밴드당 최대 한 타입). 실제 이벤트 정렬 키도 기록.
      const vOcc = new Array(virtualBands.length).fill(0)
      for (let band = 0; band < LANE_BANDS.length; band += 1) {
        if (row[band] <= 0) continue
        const vi = vbandOfBand[band]
        vOcc[vi] += row[band]
        laneOrderByDateBand.set(`${dateIso}|${band}`, vi)
      }

      // 그 날 가장 깊은(아래) 가상 밴드.
      let deepest = -1
      for (let vi = virtualBands.length - 1; vi >= 0; vi -= 1) {
        if (vOcc[vi] > 0) {
          deepest = vi
          break
        }
      }
      if (deepest < 0) continue

      // 깊은 밴드보다 "위쪽" 가상 밴드를 예약 수까지 스페이서로 채운다.
      for (let vi = 0; vi < deepest; vi += 1) {
        if (laneCountV[vi] <= 0) continue
        const need = laneCountV[vi] - vOcc[vi]
        for (let k = 0; k < need; k += 1) {
          const seq = vOcc[vi] + k
          spacers.push({
            id: `__spacer::${dateIso}::${vi}::${seq}`,
            dateIso,
            heightKey: virtualBands[vi].heightKey,
            laneOrder: vi,
            seq,
          })
        }
      }
    }
  }

  // 실제 이벤트별 laneOrder: 첫 번째 가시 날짜의 가상 밴드 인덱스(멀티데이가 상단 경계를 넘어도 안정적).
  const laneOrderByLocalId = new Map<string, number>()
  for (const event of events) {
    const band = laneBandForType(event.eventType)
    if (band === null) continue
    for (const dateIso of coveredDates(event)) {
      if (!gridDateSet.has(dateIso)) continue
      const laneOrder = laneOrderByDateBand.get(`${dateIso}|${band}`)
      if (laneOrder !== undefined) {
        laneOrderByLocalId.set(event.localId, laneOrder)
        break
      }
    }
  }

  return { spacers, laneOrderByLocalId }
}
