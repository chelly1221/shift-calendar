/**
 * 대한민국 법정공휴일 판별 유틸리티
 *
 * Google 한국 공휴일 캘린더(ko.south_korea#holiday@group.v.calendar.google.com)는
 * 법정공휴일과 기념일을 구분하지 않으므로, summary 기반으로 법정공휴일을 판별합니다.
 */

/** 법정공휴일 이름 키워드 (정규화된 형태) */
const PUBLIC_HOLIDAY_KEYWORDS: string[] = [
  // 고정 공휴일
  '새해',
  '신정',
  '삼일절',
  '어린이날',
  '현충일',
  '광복절',
  '개천절',
  '한글날',
  '크리스마스',
  '성탄절',
  // 음력 공휴일
  '설날',
  '설날전날',
  '설날다음날',
  '설날연휴',
  '추석',
  '추석전날',
  '추석다음날',
  '추석연휴',
  '부처님오신날',
  '석가탄신일',
  // 대체/임시 공휴일
  '대체공휴일',
  '대체휴일',
  '임시공휴일',
]

function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/**
 * 이벤트 summary가 법정공휴일인지 판별합니다.
 * 공백을 제거한 후 부분 매칭으로 확인하여 "대체공휴일(어린이날)" 등도 처리합니다.
 */
export function isPublicHolidayName(summary: string): boolean {
  const normalized = normalize(summary)
  return PUBLIC_HOLIDAY_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

/** 고정 날짜 법정공휴일 (MM-DD) — 오프라인 fallback용 */
export const FIXED_PUBLIC_HOLIDAY_MMDD: Set<string> = new Set([
  '01-01', // 새해/신정
  '03-01', // 삼일절
  '05-05', // 어린이날
  '06-06', // 현충일
  '08-15', // 광복절
  '10-03', // 개천절
  '10-09', // 한글날
  '12-25', // 크리스마스
])
