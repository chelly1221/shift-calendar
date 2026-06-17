/**
 * 달력에서 이벤트 타입의 세로 정렬 우선순위(위→아래). 작은 인덱스가 위에 온다.
 * FullCalendar `eventOrder="sortOrder"` 가 참조하는 `sortOrder` extendedProp 값으로 쓰인다.
 * (근무/공휴일은 FC 이벤트가 아니라 별도 셀 렌더이므로 여기 없다.)
 */
export const EVENT_TYPE_ORDER: ReadonlyArray<string> = [
  '휴가',
  '교육',
  '운용중지작업',
  '중요',
  '일반',
  '반복업무',
  '출장',
]

const ORDER_INDEX_BY_TYPE = new Map(EVENT_TYPE_ORDER.map((type, index) => [type, index] as const))

/** 이벤트 타입의 정렬 인덱스. 매핑되지 않은 타입(레거시/외부 동기화)은 null. */
export function eventTypeSortIndex(eventType: string): number | null {
  const index = ORDER_INDEX_BY_TYPE.get(eventType)
  return index === undefined ? null : index
}
