import { DateTime } from 'luxon'
import type { CalendarEvent, ShiftSettings } from './calendar'
import { expandRecurringEvents } from './expandRecurrence'
import { FIXED_PUBLIC_HOLIDAY_MMDD, isPublicHolidayName } from './koreanHolidays'
import { parseEducationTargets } from './parseEducationTargets'
import { parseVacationInfo } from './parseVacationInfo'
import { parseRoutineCompletions } from './parseRoutineCompletions'
import { buildShiftDaySummary, type RosterMember } from './shiftSummary'
import { normalizeVoiceText, parseVoiceDates, stripVoiceDates } from './voiceDates'
import { formatVoiceSpeech, speakLeaveBadges, voiceTimeLabel } from './voiceSpeech'
import { voiceAnswerSchema, type VoiceAnswer, type VoiceContext, type VoiceQuery } from './voice'

export const VOICE_EXAMPLES = ['오늘 주간 누구야?', '내일 야간 몇 명이야?', '이번 주 휴가자 알려줘', '다음 교육 언제야?', '오늘 미완료 반복업무 알려줘', '내일 일정 알려줘', '다음 달 보여줘', '내일 오후 2시에 회의 등록해줘', '내일 회의 오후 3시로 변경해줘', '내일 회의 삭제해줘']

const categoryWords: [VoiceContext['category'], RegExp][] = [
  ['휴가', /휴가|연차|반차|시간차|대휴|병가|공가/],
  ['교육', /교육|연수|훈련/],
  ['반복업무', /반복업무|루틴|체크리스트|미완료|완료|안한업무|해야할업무/],
  ['공휴일', /공휴일|빨간날/],
  ['근무', /근무|출근|주간|야간|일근|밤근무|낮근무|오늘밤|내일밤|몇조|조원|조누구/],
]
const shiftWords: [VoiceContext['shifts'][number], RegExp][] = [['주간', /주간|낮근무/], ['야간', /야간|밤근무|오늘밤|내일밤/], ['일근', /일근(?!무)/]]

function targets(event: CalendarEvent): string[] {
  if (event.eventType === '휴가') return parseVacationInfo(event.description).targets
  if (event.eventType === '교육') return parseEducationTargets(event.description).targets
  return []
}

function memberLabel(member: RosterMember): string {
  return member.name + (member.absence?.partial ? `(${member.absence.label})` : '')
}

/** Deterministic query engine. No network, database, speech recognition or generated text. */
export function answerVoiceQuery(query: VoiceQuery, inputEvents: CalendarEvent[], settings: ShiftSettings, clock: DateTime = DateTime.utc()): VoiceAnswer {
  const now = clock.setZone(query.timeZone)
  const answeredAtUtc = now.toUTC().toISO()!
  const reply = (status: VoiceAnswer['status'], text: string, context: VoiceContext | null = null, eventIds: string[] = [], speech = formatVoiceSpeech(text)): VoiceAnswer =>
    voiceAnswerSchema.parse({ status, text, speech, source: 'PC에 저장된 일정 기준', answeredAtUtc, context, eventIds })
  let text = normalizeVoiceText(query.text)
  const previous = query.context && now.toMillis() - DateTime.fromISO(query.context.answeredAtUtc).toMillis() >= 0
    && now.toMillis() - DateTime.fromISO(query.context.answeredAtUtc).toMillis() < 120_000 ? query.context : null
  const pending = previous?.clarification
  let choice: string | null = null
  if (pending?.kind === 'date') {
    const shortDate = text.replace(/(?:인가요|이야|이요|이야요|요|은|는|이|야)$/, '')
    const parsed = parseVoiceDates(shortDate, now)
    if (!stripVoiceDates(shortDate) && 'range' in parsed && parsed.range.explicit) {
      const original = normalizeVoiceText(pending.question)
      // A bare week answers "이번 주인가요, 다음 주인가요?" while retaining the weekday.
      const weekday = /[월화수목금토일]요일/.exec(original)?.[0] ?? ''
      text = shortDate + (/^(이번주|다음주|지난주|저번주|담주)$/.test(shortDate) ? weekday : '') + stripVoiceDates(original)
    }
  } else if (pending?.kind === 'event') {
    const shortChoice = text.replace(/(?:인가요|이야|이요|요|거|것|은|는)$/, '')
    if (/^(오전|오후|첫번째|두번째|세번째|첫째|둘째|셋째|[123]번|(?:오전|오후)?\d{1,2}시(?:\d{1,2}분)?)$/.test(shortChoice)
      || inputEvents.some((event) => !event.isDeleted && normalizeVoiceText(event.summary) === shortChoice)) {
      choice = shortChoice
      text = normalizeVoiceText(pending.question)
    }
  }
  if (/^(도움말|사용법|뭘물어볼수있어|무엇을물어볼수있어|질문예시)$/.test(text)) {
    return reply('ANSWER', VOICE_EXAMPLES.join('\n'))
  }
  if (/등록해|추가해|수정해|바꿔|삭제해|지워|완료처리|체크해|취소해/.test(text)) return reply('UNSUPPORTED', '날짜와 일정 제목을 함께 말씀해 주세요.')
  if (/잔여|남은연차|연차잔|수당|급여/.test(text)) return reply('UNAVAILABLE', '기준 데이터가 없어 계산할 수 없습니다.')
  if (/지금|현재근무|몇시에출근|몇시에퇴근/.test(text)) return reply('UNAVAILABLE', '교대 시각이 미등록되어 현재 근무자는 확인할 수 없습니다.')
  if (/말고/.test(text)) {
    // Only permit explicit, bounded corrections; never drop an arbitrary clause.
    text = text.replace(/(?:오늘|내일|모레|글피|어제)말고(?=오늘|내일|모레|글피|어제)/, '')
      .replace(/(?:주간|야간|일근)말고(?=주간|야간|일근)/, '')
    if (text.includes('말고')) return reply('CLARIFY', '어떤 조건으로 조회할까요?')
  }
  if (/아닌|제외|빼고|안가는|안오는|근무안|출근안|쉬는|휴무|비번/.test(text)) return reply('CLARIFY', '휴무 여부는 확인할 수 없습니다. 근무·휴가·교육 중 무엇을 조회할까요?')

  const followup = /^(그럼|그러면|그날|그사람)|^(?:오늘|내일|모레|글피|어제|주간|야간|일근|몇명|몇건|에이조|비조|씨조|디조|[abcd]조)(?:은|는|이야|야|인데)?$/.test(text)
  const inherited = followup ? previous : null
  const matchedCategories = categoryWords.filter(([, pattern]) => pattern.test(text)).map(([category]) => category)
  // A leave qualifier within a shift question is ambiguous; do not silently ignore it.
  if (matchedCategories.length > 1) return reply('CLARIFY', '근무·휴가·교육·반복업무·공휴일 중 한 종류씩 질문해 주세요.')
  const namedEvents = inputEvents.filter((event) => !event.isDeleted && normalizeVoiceText(event.summary).length >= 2 && text.includes(normalizeVoiceText(event.summary)))
  const namedType = namedEvents[0]?.eventType
  const category = matchedCategories[0] ?? (namedType && ['휴가', '교육', '반복업무', '근무', '공휴일'].includes(namedType) ? namedType as VoiceContext['category'] : namedEvents.length ? '일정' : null)
    ?? inherited?.category ?? (/일정|뭐있|무슨일|무엇이|스케줄/.test(text) ? '일정' : null)
  if (!category) return reply('UNSUPPORTED', '근무, 휴가, 일정 중 무엇을 확인할까요?')

  const dateResult = parseVoiceDates(text, now)
  if ('error' in dateResult) return reply('CLARIFY', dateResult.error, {
    category, startDate: now.toISODate()!, endDate: now.plus({ days: 1 }).toISODate()!, people: [], team: null, shifts: [], answeredAtUtc,
    clarification: { kind: 'date', question: text },
  })
  let { start, end } = dateResult.range
  const wantsNext = /다음(?!주|달)|언제/.test(text) && !dateResult.range.explicit
  if (!dateResult.range.explicit && inherited && !wantsNext) {
    start = DateTime.fromISO(inherited.startDate, { zone: query.timeZone })
    end = DateTime.fromISO(inherited.endDate, { zone: query.timeZone })
    if (end <= start || end.diff(start, 'days').days > 93) return reply('CLARIFY', '조회할 날짜를 다시 말씀해 주세요.')
  }
  if (wantsNext) end = start.plus({ days: 90 })
  const names = [...new Set([...Object.values(settings.teams).flat(), ...settings.dayWorkers, ...inputEvents.flatMap(targets)])].filter(Boolean)
  let people = names.filter((name) => text.includes(normalizeVoiceText(name)))
    .filter((name, _, all) => !all.some((other) => other.length > name.length && other.includes(name)))
  if (/(^|그럼)(나|나는|내근무|내일정|내휴가|내교육)/.test(text) && !/^내일/.test(text)) {
    if (!query.selfName || !names.includes(query.selfName)) return reply('CLARIFY', '휴대폰 연결 설정에서 캘린더에 등록된 본인 이름을 입력해 주세요.')
    people = [query.selfName]
  }
  if (!people.length && inherited) people = inherited.people
  const teamMatches = [...text.matchAll(/(에이|비|씨|시|디|[abcd])(?:조|팀)/g)].map((match) => ({ 에이: 'A', 비: 'B', 씨: 'C', 시: 'C', 디: 'D', a: 'A', b: 'B', c: 'C', d: 'D' } as const)[match[1] as 'a'])
  if (new Set(teamMatches).size > 1) return reply('CLARIFY', '어느 조를 확인할까요?')
  const team = teamMatches[0] ?? inherited?.team ?? null
  const selectedShifts = shiftWords.filter(([, pattern]) => pattern.test(text)).map(([shift]) => shift)
  const shifts = selectedShifts.length ? selectedShifts : inherited?.shifts ?? []
  const context: VoiceContext = { category, startDate: start.toISODate()!, endDate: end.toISODate()!, people, team, shifts, answeredAtUtc }
  if (team && category !== '근무' && !people.length) people = settings.teams[team]
  if (team && category !== '근무' && !people.length) return reply('UNAVAILABLE', `${team}조의 구성원이 등록되지 않았습니다.`)
  if (people.length && (category === '일정' || category === '반복업무' || category === '공휴일')) {
    return reply('CLARIFY', '사람별 조회는 근무·휴가·교육을 지원합니다. 조회할 종류를 함께 말씀해 주세요.')
  }

  // Do not turn an unknown person/title or an unhandled qualifier into an all-person answer.
  let residue = text.replace(/뭐있(?:나요|어|니)?/g, '')
  for (const value of [...people, ...namedEvents.map((event) => event.summary)]) residue = residue.split(normalizeVoiceText(value)).join('')
  residue = residue.replace(/(?:\d{4}년)?\d{1,2}월(?:\d{1,2}일)?|\d{4}-\d{2}-\d{2}|\d{1,2}일|올해|금년|내년|작년/g, '')
    .replace(/(?:에이|비|씨|시|디|[abcd])(?:조|팀)/g, '')
    .replace(/이번주|다음주|지난주|저번주|담주|이번달|다음달|지난달|저번달|이달|[월화수목금토일]요일|오늘|내일|모레|글피|어제|그저께|그제|주말/g, '')
    .replace(/반복업무|체크리스트|미완료|완료|안한업무|해야할업무|루틴|공휴일|빨간날|밤근무|낮근무|주간|야간|일근자|일근|근무자|근무|휴가자|휴가|장기|연차|반차|시간차|대휴|병가|공가|교육|연수|훈련|일정|스케줄|출근|조원|밤/g, '')
    .replace(/알려주세요|알려줘|보여주세요|보여줘|조회해줘|조회|말해줘|가르쳐줘|확인해줘|몇명이|몇명|몇건|몇번|몇조|몇시|몇개|누구|누가|언제|어디서|어디|장소|시작|종료|끝나|시각|시간|다음|가장빠른|등록된|뭐있|무슨일|무엇이|그럼|그러면|그날|그사람|안녕|안녕하세요/g, '')
    .replace(/부터|까지|하는사람|인원|명단|목록|무슨|있는지|있나요|있어|있니|들어와|들어가|인가요|인가|이야|인데|이니|해요|해|좀|전체|모두|총|나|나는|내|씨|님|은|는|을|를|이|가|의|에|야|도|랑|하고|과|와|중|가요|요/g, '')
  if (residue) return reply('CLARIFY', `“${residue.slice(0, 30)}”을 확인해 주세요. 등록된 이름이나 일정 제목이 필요합니다.`)

  const holidayMap = new Map<string, string>()
  for (const event of inputEvents) {
    if (event.isDeleted || event.eventType !== '공휴일' || !isPublicHolidayName(event.summary)) continue
    const date = DateTime.fromISO(event.startAtUtc).setZone(query.timeZone).toISODate()
    if (date) holidayMap.set(date, event.summary)
  }
  for (let date = start; date < end; date = date.plus({ days: 1 })) {
    const key = date.toISODate()!
    if (FIXED_PUBLIC_HOLIDAY_MMDD.has(date.toFormat('MM-dd')) && !holidayMap.has(key)) holidayMap.set(key, '고정 공휴일')
  }
  const events = expandRecurringEvents(inputEvents, start.toUTC().toISO()!, end.toUTC().toISO()!, new Set(holidayMap.keys()))
    .filter((event) => !event.isDeleted && DateTime.fromISO(event.startAtUtc) < end && DateTime.fromISO(event.endAtUtc) > start)
    .sort((a, b) => a.startAtUtc.localeCompare(b.startAtUtc))
  const showDates = wantsNext || end.diff(start, 'days').days > 1
  const dateLabel = (date: DateTime) => date.toFormat(date.year === now.year ? 'M월 d일' : 'yyyy년 M월 d일')
  const timeLabel = (date: DateTime) => voiceTimeLabel(date.hour, date.minute)
  const withDate = (date: DateTime, line: string) => showDates ? `${dateLabel(date)} ${line}` : line
  const wantsCount = /몇명|몇건|몇번|몇개|인원/.test(text)
  if (category === '근무') {
    if (/몇시|시간|시작|종료|장소|어디/.test(text)) return reply('UNAVAILABLE', '교대 시각과 장소는 미등록입니다.')
    if (start < now.startOf('day')) return reply('UNAVAILABLE', '과거 조원 이력이 없어 근무자를 확인할 수 없습니다.')
    const rows: string[] = []
    const selected = shifts.length ? shifts : ['일근', '주간', '야간'] as const
    for (let date = start; date < end; date = date.plus({ days: 1 })) {
      const summary = buildShiftDaySummary(date.toISODate()!, events, settings.teams, settings.dayWorkers, holidayMap, query.timeZone)
      const pieces: string[] = []
      for (const shift of selected) {
        const teams = shift === '주간' ? summary.dayTeams : shift === '야간' ? summary.nightTeams : []
        if (team && !teams.includes(team)) continue
        const roster = shift === '주간' ? summary.dayRoster : shift === '야간' ? summary.nightRoster : summary.dayWorkerRoster
        if (people.length && !roster.some((member) => people.includes(member.name))) continue
        if (shift !== '일근' && !summary.hasShiftTeams) {
          if (!wantsNext && !people.length) pieces.push(`${shift} 배정 미등록`)
          continue
        }
        const chosen = people.length ? roster.filter((member) => people.includes(member.name)) : roster
        const active = chosen.filter((member) => !member.absence || member.absence.partial)
        if (wantsNext && !active.length) continue
        const label = teams.length ? `${shift} ${teams.join('·')}조` : shift
        if (people.length === 1 && !wantsCount) {
          const absence = chosen[0]?.absence
          const state = absence && !absence.partial ? absence.label : `${label}${absence ? `, ${absence.label}` : ''}`
          if (!pieces.includes(`${state}입니다.`)) pieces.push(`${state}입니다.`)
          continue
        }
        const detail = !chosen.length
          ? shift === '일근' && summary.hideDayWorkers ? '없음(주말·공휴일)' : '구성원 미등록'
          : wantsCount ? `${active.length}명${active.some((member) => member.absence?.partial) ? '(반차·시간차 포함)' : ''}` : active.map(memberLabel).join(' ') || '없음'
        pieces.push(`${label} ${detail}`)
      }
      if (!pieces.length && people.length === 1 && !wantsCount && !wantsNext) {
        // A named leave/education status remains useful even without a shift assignment that day.
        const absences = events.filter((event) => ['휴가', '교육'].includes(event.eventType) && targets(event).includes(people[0])
          && DateTime.fromISO(event.startAtUtc) < date.plus({ days: 1 }) && DateTime.fromISO(event.endAtUtc) > date)
        const states = [...new Set(absences.map((event) => event.eventType === '휴가' ? parseVacationInfo(event.description).vacationType || '휴가' : '교육'))]
        pieces.push(states.length ? `${states.join(', ')}입니다.` : '배정 기록 없음')
      }
      if (pieces.length) rows.push(withDate(date, pieces.join(showDates ? ' / ' : '\n')))
      if (wantsNext && pieces.length) break
    }
    return reply('ANSWER', rows.join('\n') || '해당 조건의 배정 기록 없음', context, events.filter((event) => event.eventType === '근무').map((event) => event.localId))
  }
  if (category === '공휴일') {
    let days = [...holidayMap].filter(([date]) => date >= start.toISODate()! && date < end.toISODate()!).sort(([a], [b]) => a.localeCompare(b))
    if (wantsNext) days = days.slice(0, 1)
    return reply('ANSWER', wantsCount ? `등록된 공휴일 ${days.length}일` : days.map(([date, name]) => withDate(DateTime.fromISO(date, { zone: query.timeZone }), name)).join('\n') || '등록된 공휴일 없음', context)
  }
  // Broad schedule questions cover activities. Rosters, leave and holidays have their own queries.
  let selected = events.filter((event) => category === '일정'
    ? !['근무', '휴가', '공휴일'].includes(event.eventType)
    : event.eventType === category)
  if (people.length) selected = selected.filter((event) => targets(event).some((name) => people.includes(name)))
  if (namedEvents.length) {
    const titles = new Set(namedEvents.map((event) => event.summary))
    selected = selected.filter((event) => titles.has(event.summary))
  }
  const vacationKind = /장기휴가|시간차|반차|연차|대휴|병가|공가/.exec(text)?.[0]
  if (category === '휴가' && vacationKind) selected = selected.filter((event) => parseVacationInfo(event.description).vacationType?.includes(vacationKind))
  const completion = /미완료|안한업무|해야할업무/.test(text) ? 'pending' : /완료/.test(text) ? 'done' : null
  if (category === '반복업무' && completion) selected = selected.filter((event) => {
    const done = parseRoutineCompletions(event.description).completedDates.includes(DateTime.fromISO(event.startAtUtc).setZone(query.timeZone).toISODate()!)
    return completion === 'done' ? done : !done
  })
  if (wantsNext) selected = selected.filter((event) => DateTime.fromISO(event.startAtUtc) >= now).slice(0, 1)
  if (choice && pending?.kind === 'event') {
    const candidates = pending.eventIds?.length ? selected.filter((event) => pending.eventIds?.includes(event.localId)) : selected
    const ordinal = ['첫번째', '두번째', '세번째'].indexOf(choice)
    const number = ordinal >= 0 ? ordinal : /^(첫째|둘째|셋째)$/.test(choice) ? ['첫째', '둘째', '셋째'].indexOf(choice) : /^[123]번$/.test(choice) ? Number(choice[0]) - 1 : null
    // Ordinals refer to the original options, even if an event was removed meanwhile.
    const matches = candidates.filter((event) => {
      if (number !== null) return event.localId === pending.eventIds?.[number]
      const date = DateTime.fromISO(event.startAtUtc).setZone(query.timeZone)
      if (choice === '오전' || choice === '오후') return (date.hour < 12 ? '오전' : '오후') === choice
      return normalizeVoiceText(event.summary) === choice || normalizeVoiceText(timeLabel(date)) === choice
        || `${date.hour}시${date.minute ? `${date.minute}분` : ''}` === choice
    })
    if (matches.length === 1) selected = matches
    else return reply('CLARIFY', '해당 일정을 구분할 수 없습니다. 날짜와 제목을 말씀해 주세요.')
  }
  if (/몇시|시작|종료|끝나|언제|어디|장소/.test(text) && selected.length > 1) {
    const prompt = selected.length <= 3
      ? `${selected.map((event) => {
        const date = DateTime.fromISO(event.startAtUtc).setZone(query.timeZone)
        return withDate(date, `${timeLabel(date)} ${event.summary}`)
      }).join(', ')} 중 어느 일정인가요?`
      : '어느 일정인가요? 제목을 말씀해 주세요.'
    return reply('CLARIFY', prompt, { ...context, clarification: { kind: 'event', question: text, eventIds: selected.length <= 3 ? selected.map((event) => event.localId) : [] } })
  }
  let countLabel = `${selected.length}건`
  if (/몇명|인원/.test(text)) {
    if (!['휴가', '교육'].includes(category)) return reply('CLARIFY', '인원 조회는 근무·휴가·교육을 지원합니다. 일정 개수는 “몇 건”으로 질문해 주세요.')
    const incomplete = selected.some((event) => !targets(event).length)
    countLabel = `${incomplete ? '확인된 ' : ''}${new Set(selected.flatMap(targets)).size}명${incomplete ? '(일부 대상자 미등록)' : ''}`
  }
  if (wantsCount) return reply('ANSWER', countLabel, context, selected.map((event) => event.localId))
  if (category === '휴가' && !/몇시|시작|종료|끝나|언제|어디|장소/.test(text)) {
    const badgesByName = new Map<string, Set<string>>()
    for (const event of selected) {
      const vacation = parseVacationInfo(event.description)
      const names = people.length ? vacation.targets.filter((name) => people.includes(name)) : vacation.targets
      for (const name of names.length ? names : ['대상자 미등록']) {
        const badges = badgesByName.get(name) ?? new Set<string>()
        badges.add(vacation.vacationType || '종류 미등록')
        badgesByName.set(name, badges)
      }
    }
    const rows = [...badgesByName].map(([name, badges]) => `${name}-${[...badges].join('·')}`)
    return reply('ANSWER', rows.join('\n') || '휴가자 없음', context, selected.map((event) => event.localId),
      speakLeaveBadges([...badgesByName]) || '휴가자 없음')
  }
  const lines = selected.map((event) => {
    const date = DateTime.fromISO(event.startAtUtc).setZone(query.timeZone)
    const endAt = DateTime.fromISO(event.endAtUtc).setZone(query.timeZone)
    const names = targets(event)
    const allDay = date.hour === 0 && date.minute === 0 && endAt.hour === 0 && endAt.minute === 0
    const lastDay = allDay ? endAt.minus({ days: 1 }) : endAt
    const spansDays = !date.hasSame(lastDay, 'day')
    let detail: string
    if (/어디|장소/.test(text)) detail = event.location || '장소 미등록'
    else if (/몇시|시작|종료|끝나|언제/.test(text)) {
      const finish = `${date.hasSame(endAt, 'day') ? '' : `${dateLabel(endAt)} `}${timeLabel(endAt)}`
      detail = allDay ? '종일(시각 미등록)' : /종료|끝나/.test(text) && !/시작/.test(text) ? finish : /시작/.test(text) && !/종료|끝나/.test(text) ? timeLabel(date) : `${timeLabel(date)}~${finish}`
    } else if (category === '휴가') detail = `${names.join(' ') || event.summary} ${parseVacationInfo(event.description).vacationType ?? '종류 미등록'}`
    else detail = `${allDay ? '' : `${timeLabel(date)} `}${event.summary}${category !== '일정' && names.length ? ` ${names.join(' ')}` : ''}`
    // A named question needs only its requested field; broad questions keep the event title.
    if (/어디|장소|몇시|시작|종료|끝나|언제/.test(text) && !namedEvents.length) detail = `${detail} ${event.summary}`
    return spansDays ? `${dateLabel(date)}~${dateLabel(lastDay)} ${detail}` : withDate(date, detail)
  })
  return reply('ANSWER', lines.join('\n') || `해당 ${category} 기록 없음`, context, selected.map((event) => event.localId))
}
