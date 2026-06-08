import { DateTime } from 'luxon'

/**
 * 같은 주(week row) 안에서 같은 타입(형식) 이벤트를 같은 세로 위치(레인)에 맞추기 위한
 * "스페이서" 계산 로직.
 *
 * FullCalendar dayGridMonth 는 각 날짜(열)를 위에서부터 빈틈없이 쌓기 때문에, 어떤 날에
 * 우선순위 높은 타입이 더 있으면 그 아래 타입들이 밀려 내려가 옆 날짜와 세로 위치가 어긋난다.
 * 이를 막기 위해, 각 날짜에서 "그 날의 가장 아래 타입보다 위쪽 밴드" 중 비어 있는 레인을
 * 투명 스페이서 이벤트로 채워 넣는다. 그러면 같은 타입은 항상 같은 누적 높이(=같은 Y)에 놓인다.
 *
 * 핵심 규칙(균형 모드):
 * - 밴드(band) = 이벤트 타입 하나. 위→아래 우선순위 순서로 정렬(LANE_BANDS).
 * - 밴드당 정렬 레인은 최대 1개만 예약한다(laneCount cap = 1). 즉 그 주에 한 번이라도 나오는 타입은
 *   "한 줄"을 정렬 기준으로 갖는다. 한 날에 같은 타입이 여러 개여도 다른 날에 빈칸을 강요하지 않고,
 *   여분은 그 날에서만 아래로 쌓인다(바쁜 날은 살짝 어긋날 수 있으나 빈칸 낭비가 없음).
 * - 각 날짜에서, 그 날 가장 깊은(아래) 밴드보다 "위에 있는" 밴드 중 그 날에 없는 것만 1칸 스페이서로 채운다.
 *   (아래쪽 빈 레인은 채우지 않아 희소한 날은 짧게 유지 → 빈 주는 행 높이가 줄어든다.)
 */

export interface LaneEventInput {
  localId: string
  eventType: string
  /** UTC ISO. */
  startAtUtc: string
  /** UTC ISO. */
  endAtUtc: string
}

export interface LaneSpacer {
  /** FullCalendar event id. `__spacer::` 접두사로 실제 이벤트 store 와 절대 충돌하지 않는다. */
  id: string
  /** 로컬 날짜 (YYYY-MM-DD). all-day 이벤트로 이 셀에 렌더된다. */
  dateIso: string
  bandKey: string
  laneBand: number
  /** 같은 (날짜, 밴드) 안에서 스페이서 정렬/식별용 일련번호. */
  seq: number
}

/**
 * 위(top) → 아래(bottom) 우선순위 순서의 밴드 정의. 타입 하나당 밴드 하나.
 * 기존 sortOrder 우선순위(운용중지/중요 = 최상단 … 휴가/출장 = 최하단)와 동일한 순서를 유지하되,
 * "같은 형식끼리 같은 레인"을 위해 타입별로 별도 밴드를 부여한다.
 */
export const LANE_BANDS: ReadonlyArray<{ key: string; type: string }> = [
  { key: 'maint', type: '운용중지작업' },
  { key: 'important', type: '중요' },
  { key: 'basic', type: '일반' },
  { key: 'routine', type: '반복업무' },
  { key: 'edu', type: '교육' },
  { key: 'vac', type: '휴가' },
  { key: 'trip', type: '출장' },
]

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

/**
 * 그리드 가시 범위(gridStartIso 포함 ~ gridEndIso 배타)를 주(7일) 단위로 나눠 스페이서를 생성한다.
 * gridStart/gridEnd 는 FullCalendar `datesSet` 의 start/end(JSDate)에서 가져온 로컬 날짜 문자열.
 */
export function buildLaneSpacers(
  events: LaneEventInput[],
  gridStartIso: string | null,
  gridEndIso: string | null,
): LaneSpacer[] {
  if (!gridStartIso || !gridEndIso) return []
  const gridStart = DateTime.fromISO(gridStartIso).startOf('day')
  const gridEnd = DateTime.fromISO(gridEndIso).startOf('day') // 배타적
  if (!gridStart.isValid || !gridEnd.isValid || gridEnd <= gridStart) return []

  // 그리드의 날짜를 순서대로 나열.
  const gridDates: string[] = []
  for (let cursor = gridStart; cursor < gridEnd; cursor = cursor.plus({ days: 1 })) {
    const iso = cursor.toISODate()
    if (iso) gridDates.push(iso)
  }
  const gridDateSet = new Set(gridDates)

  // occupancy[dateIso][laneBand] = 그 날 그 타입의 실제 이벤트 개수.
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
  // 7일씩 주(week row) 단위로 처리.
  for (let weekStart = 0; weekStart < gridDates.length; weekStart += 7) {
    const weekDates = gridDates.slice(weekStart, weekStart + 7)

    // 이 주의 밴드별 정렬 레인 수 = 그 주에 한 번이라도 나오면 1 (cap = 1, 균형 모드).
    // 한 날에 같은 타입이 여러 개여도 다른 날의 빈칸을 늘리지 않는다.
    const laneCount = new Array(LANE_BANDS.length).fill(0)
    for (const dateIso of weekDates) {
      const row = occupancy.get(dateIso)
      if (!row) continue
      for (let band = 0; band < LANE_BANDS.length; band += 1) {
        if (row[band] > 0) laneCount[band] = 1
      }
    }

    for (const dateIso of weekDates) {
      const row = occupancy.get(dateIso)
      if (!row) continue

      // 그 날 가장 깊은(가장 아래) 밴드.
      let deepest = -1
      for (let band = LANE_BANDS.length - 1; band >= 0; band -= 1) {
        if (row[band] > 0) {
          deepest = band
          break
        }
      }
      if (deepest < 0) continue

      // 깊은 밴드보다 "위쪽" 밴드만 laneCount 까지 스페이서로 채운다.
      for (let band = 0; band < deepest; band += 1) {
        if (laneCount[band] <= 0) continue
        const need = laneCount[band] - row[band]
        for (let k = 0; k < need; k += 1) {
          const seq = row[band] + k
          spacers.push({
            id: `__spacer::${dateIso}::${LANE_BANDS[band].key}::${seq}`,
            dateIso,
            bandKey: LANE_BANDS[band].key,
            laneBand: band,
            seq,
          })
        }
      }
    }
  }

  return spacers
}
