import { DateTime } from 'luxon'

export interface VoiceDateRange { start: DateTime; end: DateTime; explicit: boolean }
export type VoiceDateResult = { range: VoiceDateRange } | { error: string }

function koreanNumber(value: string): number {
  const digits: Record<string, number> = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 }
  if (/^\d+$/.test(value)) return Number(value)
  if (value.includes('십')) {
    const [tens, units] = value.split('십')
    return (tens ? digits[tens] ?? NaN : 1) * 10 + (units ? digits[units] ?? NaN : 0)
  }
  return digits[value] ?? NaN
}

export function normalizeVoiceText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    .replace(/([일이삼사오육칠팔구십]+)(월|일)(?=[일이삼사오육칠팔구십\d]|부터|까지|에|은|의|달력|캘린더|알려|보여|열어|일정|근무|교육|휴가|주간|야간|$)/g,
      (whole, number: string, unit: string) => Number.isFinite(koreanNumber(number)) ? `${koreanNumber(number)}${unit}` : whole)
    .replace(/[?？!！,.。]/g, '')
}

/** Used only to replace a rejected date after a short clarification reply. */
export function stripVoiceDates(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}|(?:\d{4}년)?\d{1,2}월(?:\d{1,2}일)?|\d{1,2}일/g, '')
    .replace(/다다음주|다다음달|이번주|다음주|지난주|저번주|담주|이번달|다음달|지난달|저번달|이달|[월화수목금토일]요일|오늘|내일|모레|글피|어제|그저께|그제|주말|올해|금년|내년|작년|부터|까지/g, '')
}

/** Half-open local date ranges, evaluated against the PC clock, never the phone's clock. */
export function parseVoiceDates(text: string, now: DateTime): VoiceDateResult {
  const today = now.startOf('day')
  const relativeYears = [...text.matchAll(/올해|금년|내년|작년/g)]
  if (relativeYears.length > 1 || (relativeYears.length && /\d{4}년|\d{4}-\d{2}-\d{2}/.test(text))) return { error: '기준 연도를 한 가지로 말씀해 주세요.' }
  const relativeYear = relativeYears.length ? today.year + (relativeYears[0][0] === '내년' ? 1 : relativeYears[0][0] === '작년' ? -1 : 0) : undefined
  const candidates = (year: string | undefined, month: string, day: string) => {
    const specified = year ? Number(year) : relativeYear
    const years = specified === undefined ? Array.from({ length: 9 }, (_, i) => today.year + i - 4) : [specified]
    return years.map((value) => DateTime.fromObject({ year: value, month: Number(month), day: Number(day) }, { zone: now.zoneName ?? 'Asia/Seoul' }))
      .filter((date) => date.isValid)
      .sort((a, b) => Math.abs(a.toMillis() - today.toMillis()) - Math.abs(b.toMillis() - today.toMillis()) || b.toMillis() - a.toMillis())
  }
  if (/다다음|\d+(?:일|주|개월)(?:후|뒤|전)/.test(text)) return { error: '어느 날짜인가요?' }
  const make = (start: DateTime, end = start.plus({ days: 1 }), explicit = true): VoiceDateResult => {
    if (!start.isValid || !end.isValid || end <= start) return { error: '유효한 날짜로 다시 말씀해 주세요.' }
    if (end.diff(start, 'days').days > 93) return { error: '한 번에 3개월 이내의 기간을 질문해 주세요.' }
    if (start.year < today.year - 5 || end.year > today.year + 2) return { error: '현재 기준 5년 전부터 2년 후까지의 날짜를 질문해 주세요.' }
    return { range: { start, end, explicit } }
  }
  const fullDates = [...text.matchAll(/(?:(\d{4})년)?(\d{1,2})월(\d{1,2})일/g)]
  const isoDates = [...text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)]
  if (fullDates.length || isoDates.length) {
    const matches = fullDates.length ? fullDates : isoDates
    if (matches.length > 2 || (fullDates.length && isoDates.length)) return { error: '날짜를 하나 또는 시작일과 종료일로 말씀해 주세요.' }
    const choices = matches.map((match) => candidates(match[1], match[2], match[3]))
    if (choices.some((dates) => !dates.length)) return { error: '유효한 날짜로 다시 말씀해 주세요.' }
    if (choices.length === 2 && !/부터.+까지/.test(text)) return { error: '여러 날짜는 “9월 10일부터 9월 15일까지”처럼 말씀해 주세요.' }
    if (choices.length === 1 && /부터|까지/.test(text)) return { error: '시작일과 종료일을 모두 말씀해 주세요.' }
    if (/오늘|내일|모레|어제|다음주|이번주|지난주/.test(text)) return { error: '날짜 표현이 여러 개입니다. 어느 날짜인가요?' }
    if (choices.length === 1) return make(choices[0][0])
    // Resolve a range together: adjacent dates must not jump into different, reversed years.
    const ranges = choices[0].flatMap((start) => choices[1].map((last) => ({ start, end: last.plus({ days: 1 }) })))
      .filter(({ start, end }) => end > start && end.diff(start, 'days').days <= 93)
    const distance = ({ start, end }: { start: DateTime; end: DateTime }) =>
      today < start ? start.toMillis() - today.toMillis() : today >= end ? today.toMillis() - end.minus({ days: 1 }).toMillis() : 0
    ranges.sort((a, b) => distance(a) - distance(b) || b.start.toMillis() - a.start.toMillis())
    if (!ranges.length) return { error: '시작일과 종료일을 확인하고 3개월 이내의 기간으로 말씀해 주세요.' }
    return make(ranges[0].start, ranges[0].end)
  }
  const months = [...text.matchAll(/(?:(\d{4})년)?(\d{1,2})월/g)]
  if (months.length) {
    if (months.length !== 1 || /부터|까지|오늘|내일|모레|어제|이번주|다음주|지난주|이번달|다음달|지난달/.test(text)) return { error: '조회할 월을 하나로 말씀해 주세요.' }
    const match = months[0]
    const choices = candidates(match[1], match[2], '1')
    // Month-only requests compare calendar months; an exact six-month tie prefers the future.
    const offset = (date: DateTime) => (date.year - today.year) * 12 + date.month - today.month
    choices.sort((a, b) => Math.abs(offset(a)) - Math.abs(offset(b)) || offset(b) - offset(a))
    if (!choices.length) return { error: '월을 1월부터 12월 사이로 말씀해 주세요.' }
    return make(choices[0], choices[0].plus({ months: 1 }))
  }
  const relatives: [string, number][] = [['오늘', 0], ['내일', 1], ['모레', 2], ['글피', 3], ['어제', -1], ['그제', -2], ['그저께', -2]]
  const found = relatives.filter(([word]) => text.includes(word))
  if (found.length > 1) return { error: '어느 날짜인가요?' }
  if (found.length) {
    if (/부터|까지/.test(text)) return { error: '날짜 범위는 “9월 10일부터 9월 15일까지”처럼 말씀해 주세요.' }
    return make(today.plus({ days: found[0][1] }))
  }
  const week = /이번주|다음주|담주|지난주|저번주/.exec(text)?.[0]
  const weekday = /(월|화|수|목|금|토|일)요일/.exec(text)
  if (week || text.includes('주말')) {
    const offset = week === '다음주' || week === '담주' ? 1 : week === '지난주' || week === '저번주' ? -1 : 0
    const start = today.startOf('week').plus({ weeks: offset })
    if (weekday) return make(start.plus({ days: '월화수목금토일'.indexOf(weekday[1]) }))
    if (text.includes('주말')) return make(start.plus({ days: 5 }), start.plus({ days: 7 }))
    return make(start, start.plus({ weeks: 1 }))
  }
  if (weekday) return { error: '이번 주인가요, 다음 주인가요?' }
  const month = /이번달|이달|다음달|지난달|저번달/.exec(text)?.[0]
  const day = /(?<!\d)(\d{1,2})일/.exec(text)
  if (month || day) {
    const start = today.startOf('month').plus({ months: month === '다음달' ? 1 : month === '지난달' || month === '저번달' ? -1 : 0 })
    if (day) return make(DateTime.fromObject({ year: start.year, month: start.month, day: Number(day[1]) }, { zone: now.zoneName ?? 'Asia/Seoul' }))
    return make(start, start.plus({ months: 1 }))
  }
  if (/\d|월|주후|일후|올해|내년|작년|다다음|며칠뒤/.test(text)) return { error: '어느 날짜인가요?' }
  return make(today, today.plus({ days: 1 }), false)
}
