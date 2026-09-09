import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import type { CalendarEvent, DeleteCalendarEventInput, ShiftSettings, UpsertCalendarEventInput } from '../../shared/calendar'
import { upsertCalendarEventSchema } from '../../shared/calendar'
import { buildShiftNameContext, inferVacationEvent } from '../../shared/eventTitleMapper'
import { expandRecurringEvents, extractMasterLocalId, isVirtualInstance, LOCAL_SERIES_PREFIX } from '../../shared/expandRecurrence'
import { isPublicHolidayName } from '../../shared/koreanHolidays'
import { serializeEducationTargets } from '../../shared/parseEducationTargets'
import { parseRoutineCompletions, serializeRoutineCompletions } from '../../shared/parseRoutineCompletions'
import { parseVoiceCommand } from '../../shared/voiceCommands'
import { normalizeVoiceText } from '../../shared/voiceDates'
import { answerVoiceQuery } from '../../shared/voiceQuery'
import { formatVoiceSpeech } from '../../shared/voiceSpeech'
import type { VoiceAnswer, VoiceControl, VoiceQuery } from '../../shared/voice'

interface Dependencies {
  events: () => Promise<CalendarEvent[]>
  settings: () => Promise<ShiftSettings>
  upsert: (input: UpsertCalendarEventInput) => Promise<CalendarEvent>
  remove: (input: DeleteCalendarEventInput) => Promise<boolean>
  control: (control: VoiceControl) => Promise<string>
  sync: () => Promise<string>
  clock?: () => DateTime
}
interface PendingAction { expires: number; execute: () => Promise<VoiceAnswer>; result?: Promise<VoiceAnswer> }

export class VoiceCommandService {
  private pending = new Map<string, PendingAction>()
  constructor(private readonly deps: Dependencies) {}
  private now(): DateTime { return (this.deps.clock?.() ?? DateTime.utc()).setZone('Asia/Seoul') }
  private reply(status: VoiceAnswer['status'], text: string): VoiceAnswer {
    return { status, text, speech: formatVoiceSpeech(text), source: 'PC에 저장된 일정 기준', answeredAtUtc: this.now().toUTC().toISO()!, context: null, eventIds: [] }
  }
  clear(): void { this.pending.clear() }
  private preview(text: string, execute: () => Promise<VoiceAnswer>): VoiceAnswer {
    for (const [id, pending] of this.pending) if (pending.expires < this.now().toMillis()) this.pending.delete(id)
    if (this.pending.size >= 100) return this.reply('UNAVAILABLE', '확인 대기 중인 작업이 많습니다. 잠시 후 다시 시도해 주세요.')
    const id = randomUUID()
    this.pending.set(id, { expires: this.now().toMillis() + 120_000, execute })
    return { ...this.reply('PREVIEW', `${text}\n확인 또는 취소라고 말씀해 주세요.`), confirmationId: id }
  }
  async confirm(id: string, confirm: boolean): Promise<VoiceAnswer> {
    const action = this.pending.get(id)
    if (!action || action.expires < this.now().toMillis()) return this.reply('UNAVAILABLE', '확인 시간이 지났습니다. 명령을 다시 말씀해 주세요.')
    if (action.result) return action.result
    if (!confirm) { action.result = Promise.resolve(this.reply('ANSWER', '취소했습니다.')); return action.result }
    // Store the promise before invoking any write: retries cannot execute twice.
    action.result = Promise.resolve().then(action.execute).catch(() => this.reply('UNAVAILABLE', '작업 완료 여부를 확인하지 못했습니다. 중복 등록을 피하려면 PC 캘린더에서 결과를 확인한 뒤 다시 시도해 주세요.'))
    return action.result
  }
  private async saved(message: string): Promise<VoiceAnswer> {
    try { await this.deps.control({ type: 'REFRESH' }) }
    catch { return this.reply('ANSWER', `${message} PC 화면 새로고침을 확인하지 못했습니다.`) }
    return this.reply('ANSWER', message)
  }
  async query(query: VoiceQuery): Promise<VoiceAnswer> {
    const command = parseVoiceCommand(query.text, this.now())
    if (command.kind === 'clarify') return this.reply('CLARIFY', command.text)
    if (command.kind === 'control') {
      try { await this.deps.control(command.control); return this.reply('ANSWER', '') }
      catch { return this.reply('UNAVAILABLE', 'PC 화면에서 명령을 처리했는지 확인하지 못했습니다. PC 앱 상태를 확인해 주세요.') }
    }
    if (command.kind === 'sync') {
      try { await this.deps.sync(); return this.reply('ANSWER', '') }
      catch { return this.reply('UNAVAILABLE', '동기화를 완료하지 못했습니다. PC의 동기화 화면을 확인해 주세요.') }
    }
    const [events, settings] = await Promise.all([this.deps.events(), this.deps.settings()])
    if (command.kind === 'query') return answerVoiceQuery(query, events, settings, this.now())
    if (command.kind === 'create') {
      let input = command.input
      const inferred = inferVacationEvent(input.summary, input.description, buildShiftNameContext(settings))
      if (input.eventType === '일반' && inferred) input = { ...input, eventType: inferred.eventType, summary: inferred.summary, description: inferred.description }
      if (input.eventType === '교육') {
        const names = [...new Set([...Object.values(settings.teams).flat(), ...settings.dayWorkers])].filter((name) => normalizeVoiceText(input.summary).includes(normalizeVoiceText(name)))
        input = { ...input, description: serializeEducationTargets(names, input.description) }
      }
      input = upsertCalendarEventSchema.parse(input)
      const start = DateTime.fromISO(input.startAtUtc).setZone('Asia/Seoul')
      const end = DateTime.fromISO(input.endAtUtc).setZone('Asia/Seoul')
      const duplicate = events.some((event) => !event.isDeleted && normalizeVoiceText(event.summary) === normalizeVoiceText(input.summary) && event.startAtUtc === input.startAtUtc && event.endAtUtc === input.endAtUtc)
      if (duplicate) return this.reply('CLARIFY', '같은 제목과 시간의 일정이 이미 있습니다. 기존 일정을 조회해 주세요.')
      const label = `등록: [${input.eventType}] ${input.summary}\n${start.toFormat('yyyy년 M월 d일 HH:mm')}~${end.toFormat(start.hasSame(end, 'day') ? 'HH:mm' : 'yyyy년 M월 d일 HH:mm')}${input.recurrenceRule ? `\n${input.recurrenceRule.includes('DAILY') ? '매일' : input.recurrenceRule.includes('WEEKLY') ? '매주' : '매월'} 반복 · 종료일 없음` : ''}${input.description ? `\n${input.description}` : ''}`
      return this.preview(label, async () => {
        const current = await this.deps.events()
        if (current.some((event) => !event.isDeleted && normalizeVoiceText(event.summary) === normalizeVoiceText(input.summary) && event.startAtUtc === input.startAtUtc && event.endAtUtc === input.endAtUtc)) return this.reply('CLARIFY', '확인하는 동안 같은 일정이 등록되어 중복 등록하지 않았습니다.')
        await this.deps.upsert(input)
        return this.saved(`${input.summary} 등록 완료`)
      })
    }
    const start = DateTime.fromISO(command.date, { zone: 'Asia/Seoul' })
    const end = start.plus({ days: 1 })
    const holidayDates = new Set(events.filter((event) => !event.isDeleted && event.eventType === '공휴일' && isPublicHolidayName(event.summary)).map((event) => DateTime.fromISO(event.startAtUtc).setZone('Asia/Seoul').toISODate()!))
    const candidates = expandRecurringEvents(events, start.toUTC().toISO()!, end.toUTC().toISO()!, holidayDates).filter((event) => !event.isDeleted && DateTime.fromISO(event.startAtUtc) < end && DateTime.fromISO(event.endAtUtc) > start && normalizeVoiceText(event.summary) === command.title)
    if (candidates.length !== 1) return this.reply('CLARIFY', candidates.length ? '같은 제목의 일정이 여러 개입니다. PC에서 선택해 주세요.' : '일정을 찾지 못했습니다. 날짜와 제목을 다시 말씀해 주세요.')
    const target = candidates[0]
    if (target.eventType === '근무' || target.eventType === '공휴일') return this.reply('CLARIFY', '근무 배정과 공휴일은 PC에서 변경해 주세요. 개인 일정·휴가·교육·반복업무를 변경할 수 있습니다.')
    const targetId = isVirtualInstance(target.localId) ? extractMasterLocalId(target.localId) : target.localId
    const base = events.find((event) => event.localId === targetId)!
    if (!base) return this.reply('UNAVAILABLE', '원본 일정을 찾을 수 없습니다. PC 캘린더를 확인해 주세요.')
    const recurring = Boolean(base.recurrenceRule || base.recurringEventId)
    const completion = command.action === 'complete' || command.action === 'uncomplete'
    if (recurring && !command.scope && !completion) return this.reply('CLARIFY', '반복 일정입니다. 명령에 “이번만”, “전체”, “이후”를 넣어 다시 말씀해 주세요.')
    if (completion && target.eventType !== '반복업무') return this.reply('CLARIFY', '완료 표시는 반복업무에만 사용할 수 있습니다.')
    if (completion && command.scope && command.scope !== 'THIS') return this.reply('CLARIFY', '완료 표시는 질문한 날짜의 반복업무 한 건에 적용합니다. “이번만”으로 말씀해 주세요.')
    const scope = recurring ? completion ? 'THIS' : command.scope! : 'ALL'
    if (recurring && scope === 'ALL' && command.startAtUtc) return this.reply('CLARIFY', '반복 일정의 시각 변경은 “이번만” 또는 “이후”로 지정해 주세요.')
    const family = base.recurringEventId ?? base.googleEventId ?? `${LOCAL_SERIES_PREFIX}${base.localId}`
    const signature = (items: CalendarEvent[]) => JSON.stringify(items.filter((event) => event.localId === base.localId || event.googleEventId === family || event.recurringEventId === family).map((event) => ({ id: event.localId, edited: event.localEditedAtUtc, remote: event.googleUpdatedAtUtc, deleted: event.isDeleted, start: event.startAtUtc, end: event.endAtUtc, title: event.summary, description: event.description, rule: event.recurrenceRule })).sort((a, b) => a.id.localeCompare(b.id)))
    const snapshot = signature(events)
    const input: UpsertCalendarEventInput = upsertCalendarEventSchema.parse({ ...target, localId: targetId, googleEventId: base.googleEventId, sendUpdates: 'none', recurrenceScope: scope, originalStartTimeUtc: target.originalStartTimeUtc ?? target.startAtUtc })
    if (isVirtualInstance(target.localId)) input.recurrenceRule = base.recurrenceRule
    if (command.summary) input.summary = command.summary
    if (command.startAtUtc) {
      let next = DateTime.fromISO(command.startAtUtc).setZone('Asia/Seoul')
      const old = DateTime.fromISO(target.startAtUtc).setZone('Asia/Seoul')
      if (command.dateOnly) next = next.set({ hour: old.hour, minute: old.minute, second: old.second, millisecond: old.millisecond })
      input.startAtUtc = next.toUTC().toISO()!
      input.endAtUtc = next.plus({ milliseconds: Date.parse(target.endAtUtc) - Date.parse(target.startAtUtc) }).toUTC().toISO()!
    }
    if (completion) {
      const parsed = parseRoutineCompletions(target.description)
      const dates = parsed.completedDates.filter((date) => date !== command.date)
      if (command.action === 'complete') dates.push(command.date)
      input.description = serializeRoutineCompletions(dates, parsed.cleanDescription)
    }
    const actionLabel = command.action === 'delete' ? '삭제' : command.action === 'complete' ? '완료 표시' : command.action === 'uncomplete' ? '완료 표시 취소' : '변경'
    const scopeLabel = recurring ? `\n적용 범위: ${scope === 'THIS' ? '이번 일정만' : scope === 'ALL' ? '전체 반복 일정' : '이 날짜 이후 반복 일정'}` : ''
    return this.preview(`${command.date} ${target.summary}: ${actionLabel}${command.action === 'update' ? `\n변경 후: ${input.summary}, ${DateTime.fromISO(input.startAtUtc).setZone('Asia/Seoul').toFormat('yyyy년 M월 d일 HH:mm')}` : ''}${scopeLabel}`, async () => {
      if (signature(await this.deps.events()) !== snapshot) return this.reply('CLARIFY', '확인하는 동안 일정이 변경되었습니다. 명령을 다시 말씀해 주세요.')
      if (command.action === 'delete') {
        const removed = await this.deps.remove({ localId: targetId, recurrenceScope: scope, sendUpdates: 'none', originalStartTimeUtc: target.originalStartTimeUtc ?? target.startAtUtc })
        if (!removed) return this.reply('UNAVAILABLE', '삭제할 일정을 찾지 못했습니다. PC에서 확인해 주세요.')
      } else await this.deps.upsert(input)
      return this.saved(`${target.summary} ${actionLabel} 완료`)
    })
  }
}
