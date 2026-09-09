import { DateTime } from 'luxon'
import type { RecurrenceEditScope, UpsertCalendarEventInput } from './calendar'
import type { VoiceControl } from './voice'
import { normalizeVoiceText, parseVoiceDates } from './voiceDates'

export type VoiceCommand =
  | { kind: 'query' }
  | { kind: 'clarify'; text: string }
  | { kind: 'control'; control: VoiceControl }
  | { kind: 'sync' }
  | { kind: 'create'; input: UpsertCalendarEventInput }
  | { kind: 'change'; action: 'update' | 'delete' | 'complete' | 'uncomplete'; title: string; date: string; scope: RecurrenceEditScope | null; startAtUtc?: string; summary?: string; dateOnly?: boolean }

const datePattern = /\d{4}-\d{2}-\d{2}|(?:\d{4}년|올해|금년|내년|작년)?\d{1,2}월\d{1,2}일|(?:이번주|다음주|지난주)[월화수목금토일]요일|오늘|내일|모레|글피|어제|그저께|그제/g
const timePattern = /(오전|오후|아침|저녁|밤)?(\d{1,2}|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)시(?:(\d{1,2})분|(반))?/g
const actionEnding = /(?:일정)?(?:등록|추가|생성|변경|수정|이동|옮겨|삭제|지워|미완료처리|완료취소|완료처리|완료표시)(?:해줘|해주세요|해|줘|주세요)?$/

/** Only explicit command grammars create actions; everything else stays a query. */
export function parseVoiceCommand(raw: string, clock: DateTime = DateTime.utc()): VoiceCommand {
  const now = clock.setZone('Asia/Seoul')
  const text = normalizeVoiceText(raw).replace(/정오/g, '오후12시').replace(/자정/g, '오전12시')
  const clarify = (message: string): VoiceCommand => ({ kind: 'clarify', text: message })
  if (/^(?:구글)?(?:지금)?동기화(?:해줘|해주세요|해)?$/.test(text)) return { kind: 'sync' }
  if (/^(?:다음달|다음월|한달뒤)(?:로)?(?:보여줘|보여주세요|이동해줘|넘겨줘|넘겨|가줘)$/.test(text)) return { kind: 'control', control: { type: 'NEXT_MONTH' } }
  if (/^(?:이전달|지난달|저번달|전달)(?:로)?(?:보여줘|보여주세요|이동해줘|넘겨줘|넘겨|가줘)$/.test(text)) return { kind: 'control', control: { type: 'PREVIOUS_MONTH' } }
  if (/^(?:오늘|이번달)(?:로)?(?:보여줘|보여주세요|이동해줘|가줘)$/.test(text)) return { kind: 'control', control: { type: 'TODAY' } }
  for (const [pattern, type] of [
    [/^(?:근무표|근무자화면|2주근무표)(?:를)?(?:보여줘|열어줘|보여주세요)$/, 'OPEN_ROSTER'],
    [/^(?:달력|캘린더)(?:를)?(?:보여줘|열어줘|보여주세요)$/, 'OPEN_CALENDAR'],
    [/^설정(?:을)?(?:열어줘|보여줘)$/, 'OPEN_SETTINGS'],
    [/^동기화(?:창|화면)(?:을)?(?:열어줘|보여줘)$/, 'OPEN_SYNC'],
  ] as const) if (pattern.test(text)) return { kind: 'control', control: { type } }
  const goto = text.match(/^(.+?)(?:로)?(?:이동해줘|이동해주세요|보여줘|보여주세요|알려줘|알려주세요|열어줘)$/)
  if (goto && !/일정|근무|교육|휴가/.test(goto[1])) {
    const value = goto[1].replace(/로$/, '').replace(/(?:달력|캘린더)(?:을|를)?$/, '')
    if (!/^(?:(?:\d{4}년|올해|금년|내년|작년)?\d{1,2}월(?:\d{1,2}일)?|\d{4}-\d{2}-\d{2}|오늘|내일|모레|이번달|다음달|지난달|\d{1,2}일|(?:이번주|다음주|지난주)(?:[월화수목금토일]요일)?)$/.test(value)) return { kind: 'query' }
    const result = parseVoiceDates(value, now)
    if ('error' in result) return clarify(result.error)
    return { kind: 'control', control: { type: 'GOTO_DATE', date: result.range.start.toISODate()! } }
  }
  const ending = text.match(actionEnding)
  if (!ending) return { kind: 'query' }
  if (/모든일정|전부/.test(text)) return clarify('여러 일정을 한꺼번에 변경하거나 삭제하지 않습니다. 날짜와 일정 제목을 지정해 주세요.')
  if (/말고|하지마|하지않|안해|제외|아닌|빼고|또는|아니면|등록하고|추가하고|삭제하고|변경하고/.test(text)) return clarify('실행할 내용 한 가지만 다시 말씀해 주세요. 부정·제외·선택 조건이 있는 변경 명령은 실행하지 않습니다.')
  if (/대체근무|대리근무|근무조|조원|일근자/.test(text)) return clarify('근무 편성 변경은 PC의 근무표에서 해 주세요. 일정 등록·변경·삭제와 반복업무 완료 처리를 지원합니다.')
  const dateMatches = [...text.matchAll(datePattern)]
  if (!dateMatches.length || dateMatches.length > 2) return clarify('날짜를 넣어 다시 말씀해 주세요.')
  const isCreate = /등록|추가|생성/.test(ending[0])
  const dates: DateTime[] = []
  if (isCreate && dateMatches.length === 2 && /부터.+까지/.test(text)) {
    const result = parseVoiceDates(`${dateMatches[0][0]}부터${dateMatches[1][0]}까지`, now)
    if ('error' in result) return clarify(result.error)
    dates.push(result.range.start, result.range.end.minus({ days: 1 }))
  } else {
    for (const match of dateMatches) {
      const result = parseVoiceDates(match[0], now)
      if ('error' in result) return clarify(result.error)
      dates.push(result.range.start)
    }
  }
  if (!isCreate && /매일|매주|매월|종일/.test(text)) return clarify('반복 주기나 종일 여부 변경은 PC에서 해 주세요. 음성으로는 제목·시작 날짜·시각을 변경할 수 있습니다.')
  const isDelete = /삭제|지워/.test(ending[0])
  const isUncomplete = /미완료|완료취소/.test(ending[0])
  const isComplete = !isUncomplete && /완료/.test(ending[0])
  const timeMatches = [...text.matchAll(timePattern)]
  if (timeMatches.length > 2) return clarify('시작 시각과 종료 시각만 말씀해 주세요.')
  const times: Array<{ hour: number; minute: number }> = []
  const hourWords: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 }
  for (const match of timeMatches) {
    let hour = hourWords[match[2]] ?? Number(match[2])
    const minute = match[4] ? 30 : Number(match[3] || 0)
    if (match[1] === '밤' && hour === 12) return clarify('밤 12시는 날짜가 모호합니다. 정확한 날짜와 “오전 0시” 또는 “오후 12시”로 말씀해 주세요.')
    if (hour > 23 || minute > 59 || (match[1] && hour > 12)) return clarify('유효한 시각으로 다시 말씀해 주세요.')
    if (!match[1] && hour > 0 && hour <= 12) return clarify('오전 또는 오후를 넣어 다시 말씀해 주세요.')
    if (match[1]) { hour %= 12; if (['오후', '저녁', '밤'].includes(match[1])) hour += 12 }
    times.push({ hour, minute })
  }
  let remainder = text.replace(actionEnding, '').replace(datePattern, '|').replace(timePattern, '|')
  const scope = /전체|모두/.test(text) ? 'ALL' : /이후/.test(text) ? 'FUTURE' : /이번만|이번일정만|이일정만/.test(text) ? 'THIS' : null
  remainder = remainder.replace(/이번일정만|이번만|이일정만|전체|모두|이후/g, '').replace(/매일|매주|매월|종일/g, '')
    .replace(/\|(?:부터|까지|으로|로|에)?/g, '').replace(/(?:으로|로|을|를)$/, '')
  const rename = remainder.match(/^(.+?)(?:제목을|제목)(.+?)$/)
  const title = rename ? rename[1] : remainder
  if (!title || title === '일정' || title.length > 120 || /전부|모든일정/.test(title)) return clarify('일정 제목을 넣어 다시 말씀해 주세요.')
  const targetDate = dates[0].toISODate()!
  if (isDelete || isComplete || isUncomplete) {
    if (times.length || dates.length > 1) return clarify('대상 일정의 날짜와 제목만 말씀해 주세요. 예: 내일 회의 삭제해줘.')
    return { kind: 'change', action: isDelete ? 'delete' : isUncomplete ? 'uncomplete' : 'complete', title, date: targetDate, scope }
  }
  const destination = dates[dates.length - 1]
  if (!isCreate) {
    if (times.length > 1) return clarify('변경할 시작 시각만 말씀해 주세요. 일정 길이는 유지합니다.')
    if (rename) {
      if (times.length || dates.length > 1) return clarify('제목 변경과 날짜·시각 변경은 한 가지씩 말씀해 주세요.')
      return { kind: 'change', action: 'update', title, date: targetDate, scope, summary: rename[2] }
    }
    if (!times.length && dates.length < 2) return clarify('바꿀 날짜나 시각을 넣어 다시 말씀해 주세요.')
    return { kind: 'change', action: 'update', title, date: targetDate, scope, startAtUtc: (times.length ? destination.set(times[0]) : destination).toUTC().toISO()!, dateOnly: !times.length }
  }
  const vacation = /휴가|연차|반차|시간차|대휴|병가|공가/.test(title)
  const allDay = text.includes('종일') || (vacation && !times.length)
  if (!times.length && !allDay) return clarify('시각 또는 “종일”을 넣어 다시 말씀해 주세요.')
  if (allDay && times.length) return clarify('종일 일정과 시간 지정 중 하나로 말씀해 주세요.')
  if (dates.length === 2 && !/부터.+까지/.test(text)) return clarify('기간은 “9월 10일부터 9월 15일까지”처럼 말씀해 주세요.')
  if (dates.length === 2 && !allDay && times.length !== 2) return clarify('여러 날에 걸친 시간 일정은 시작과 종료 시각을 모두 말씀해 주세요.')
  const start = times.length ? dates[0].set(times[0]) : dates[0]
  const end = allDay ? destination.plus({ days: 1 }) : times.length === 2 ? destination.set(times[1]) : start.plus({ hours: 1 })
  if (end <= start || end.diff(start, 'days').days > 93) return clarify('종료 시각이 시작보다 늦어야 하며, 일정 기간은 3개월 이내로 지정해 주세요.')
  const recurrence = text.includes('매일') ? 'FREQ=DAILY' : text.includes('매주') ? 'FREQ=WEEKLY' : text.includes('매월') ? 'FREQ=MONTHLY' : null
  if (['매일', '매주', '매월'].filter((word) => text.includes(word)).length > 1) return clarify('반복 주기는 한 가지만 말씀해 주세요.')
  return { kind: 'create', input: {
    eventType: vacation ? '일반' : title.includes('교육') ? '교육' : title.includes('반복업무') ? '반복업무' : '일반',
    summary: title, description: '', location: '', startAtUtc: start.toUTC().toISO()!, endAtUtc: end.toUTC().toISO()!, timeZone: 'Asia/Seoul',
    attendees: [], sendUpdates: 'none', recurrenceScope: 'ALL', recurrenceRule: recurrence, skipWeekendsAndHolidays: false,
  } }
}
