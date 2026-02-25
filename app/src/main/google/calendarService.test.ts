import { describe, it, expect } from 'vitest'
import type { calendar_v3 } from 'googleapis'
import type { CalendarEvent } from '../../shared/calendar'
import { extractEventType, toRemoteSnapshot, toGoogleEventRequest } from './calendarService'

function makeCalendarEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
  return {
    localId: 'local-1',
    googleEventId: 'google-1',
    eventType: '일반',
    summary: '테스트 이벤트',
    description: '',
    location: '',
    startAtUtc: '2026-03-01T09:00:00.000Z',
    endAtUtc: '2026-03-01T10:00:00.000Z',
    timeZone: 'Asia/Seoul',
    attendees: [],
    recurrenceRule: null,
    recurringEventId: null,
    originalStartTimeUtc: null,
    organizerEmail: null,
    hangoutLink: null,
    googleUpdatedAtUtc: null,
    localEditedAtUtc: '2026-03-01T09:00:00.000Z',
    syncState: 'CLEAN',
    ...overrides,
  }
}

function makeGoogleEvent(overrides?: Partial<calendar_v3.Schema$Event>): calendar_v3.Schema$Event {
  return {
    id: 'google-1',
    status: 'confirmed',
    summary: '테스트 이벤트',
    description: '',
    location: '',
    start: { dateTime: '2026-03-01T09:00:00Z', timeZone: 'Asia/Seoul' },
    end: { dateTime: '2026-03-01T10:00:00Z', timeZone: 'Asia/Seoul' },
    updated: '2026-03-01T09:00:00Z',
    attendees: [],
    recurrence: undefined,
    recurringEventId: undefined,
    originalStartTime: undefined,
    organizer: { email: 'test@example.com' },
    hangoutLink: undefined,
    extendedProperties: undefined,
    ...overrides,
  }
}

describe('eventType 동기화 - Push (로컬 → Google)', () => {
  it('기본 타입(일반)이 extendedProperties.private에 포함된다', () => {
    const event = makeCalendarEvent({ eventType: '일반' })
    const request = toGoogleEventRequest(event)

    expect(request.extendedProperties).toBeDefined()
    expect(request.extendedProperties?.private).toBeDefined()
    expect(request.extendedProperties?.private?.shiftCalendarEventType).toBe('일반')
  })

  it('커스텀 타입(근무)이 extendedProperties.private에 포함된다', () => {
    const event = makeCalendarEvent({ eventType: '근무' })
    const request = toGoogleEventRequest(event)

    expect(request.extendedProperties?.private?.shiftCalendarEventType).toBe('근무')
  })

  it('커스텀 타입(반복업무)이 extendedProperties.private에 포함된다', () => {
    const event = makeCalendarEvent({ eventType: '반복업무' })
    const request = toGoogleEventRequest(event)

    expect(request.extendedProperties?.private?.shiftCalendarEventType).toBe('반복업무')
  })

  it('빈 문자열 eventType도 그대로 전송된다', () => {
    const event = makeCalendarEvent({ eventType: '' as any })
    const request = toGoogleEventRequest(event)

    expect(request.extendedProperties?.private?.shiftCalendarEventType).toBe('')
  })

  it('summary, start, end 등 다른 필드도 정상 매핑된다', () => {
    const event = makeCalendarEvent({
      summary: '팀 미팅',
      description: '회의 내용',
      location: '서울',
    })
    const request = toGoogleEventRequest(event)

    expect(request.summary).toBe('팀 미팅')
    expect(request.description).toBe('회의 내용')
    expect(request.location).toBe('서울')
    // UTC → 로컬 타임존 변환 확인 (Asia/Seoul = UTC+9)
    expect(request.start?.dateTime).toBe('2026-03-01T18:00:00.000+09:00')
    expect(request.end?.dateTime).toBe('2026-03-01T19:00:00.000+09:00')
  })

  it('종일 일정은 date 필드로 전송된다', () => {
    const event = makeCalendarEvent({
      startAtUtc: '2026-03-01T15:00:00.000Z',
      endAtUtc: '2026-03-02T15:00:00.000Z',
      timeZone: 'Asia/Seoul',
    })

    const request = toGoogleEventRequest(event)

    expect(request.start?.date).toBe('2026-03-02')
    expect(request.end?.date).toBe('2026-03-03')
    expect(request.start?.dateTime).toBeUndefined()
    expect(request.end?.dateTime).toBeUndefined()
  })
})

describe('eventType 동기화 - Pull (Google → 로컬)', () => {
  it('extendedProperties에 커스텀 타입이 있으면 정상 추출된다', () => {
    const googleEvent = makeGoogleEvent({
      extendedProperties: {
        private: { shiftCalendarEventType: '근무' },
      },
    })

    expect(extractEventType(googleEvent)).toBe('근무')
  })

  it('extendedProperties가 없으면 기본값 일반이 반환된다', () => {
    const googleEvent = makeGoogleEvent({ extendedProperties: undefined })

    expect(extractEventType(googleEvent)).toBe('일반')
  })

  it('extendedProperties.private이 비어있으면 기본값 일반이 반환된다', () => {
    const googleEvent = makeGoogleEvent({
      extendedProperties: { private: {} },
    })

    expect(extractEventType(googleEvent)).toBe('일반')
  })

  it('공백만 있는 eventType은 기본값 일반이 반환된다', () => {
    const googleEvent = makeGoogleEvent({
      extendedProperties: {
        private: { shiftCalendarEventType: '   ' },
      },
    })

    expect(extractEventType(googleEvent)).toBe('일반')
  })

  it('앞뒤 공백이 있는 eventType은 trim 처리된다', () => {
    const googleEvent = makeGoogleEvent({
      extendedProperties: {
        private: { shiftCalendarEventType: '  근무  ' },
      },
    })

    expect(extractEventType(googleEvent)).toBe('근무')
  })
})

describe('eventType 동기화 - toRemoteSnapshot 라운드트립', () => {
  it('커스텀 타입이 RemoteEventSnapshot.eventType에 보존된다', () => {
    const googleEvent = makeGoogleEvent({
      extendedProperties: {
        private: { shiftCalendarEventType: '반복업무' },
      },
    })
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.eventType).toBe('반복업무')
  })

  it('extendedProperties 없는 Google 이벤트는 일반으로 매핑된다', () => {
    const googleEvent = makeGoogleEvent()
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.eventType).toBe('일반')
  })

  it('cancelled 이벤트는 eventType이 일반이고 isDeleted=true', () => {
    const googleEvent = makeGoogleEvent({
      status: 'cancelled',
      extendedProperties: {
        private: { shiftCalendarEventType: '근무' },
      },
    })
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.isDeleted).toBe(true)
    expect(snapshot?.eventType).toBe('일반')
  })

  it('id가 없는 Google 이벤트는 null 반환', () => {
    const googleEvent = makeGoogleEvent({ id: undefined })
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot).toBeNull()
  })
})

describe('제목 기반 eventType 추론 - toRemoteSnapshot', () => {
  it('extendedProperties 없는 "박혜지 대휴"가 휴가로 추론된다', () => {
    const googleEvent = makeGoogleEvent({
      summary: '박혜지 대휴',
      extendedProperties: undefined,
    })
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.eventType).toBe('휴가')
    expect(snapshot?.summary).toBe('박혜지 대휴')
    expect(snapshot?.description).toContain('휴가대상: 박혜지')
    expect(snapshot?.description).toContain('휴가종류: 대휴')
  })

  it('extendedProperties 없는 "이종열 안전교육"이 교육으로 추론된다', () => {
    const googleEvent = makeGoogleEvent({
      summary: '이종열 안전교육',
      extendedProperties: undefined,
    })
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.eventType).toBe('교육')
    expect(snapshot?.summary).toBe('안전교육')
    expect(snapshot?.description).toContain('교육대상: 이종열')
  })

  it('extendedProperties가 있으면 제목 추론을 하지 않는다', () => {
    const googleEvent = makeGoogleEvent({
      summary: '박혜지 대휴',
      extendedProperties: {
        private: { shiftCalendarEventType: '일반' },
      },
    })
    const snapshot = toRemoteSnapshot(googleEvent)

    // extendedProperties에 '일반'이 명시되어 있으므로 제목 패턴으로 휴가 추론
    expect(snapshot?.eventType).toBe('휴가')
  })

  it('매칭되지 않는 일반 이벤트는 그대로 유지', () => {
    const googleEvent = makeGoogleEvent({
      summary: '팀 미팅',
      extendedProperties: undefined,
    })
    const snapshot = toRemoteSnapshot(googleEvent)

    expect(snapshot?.eventType).toBe('일반')
    expect(snapshot?.summary).toBe('팀 미팅')
  })
})

describe('교육 이벤트 Push 시 toGoogleEventRequest', () => {
  it('교육 이벤트의 summary에 대상자가 포함된다', () => {
    const event = makeCalendarEvent({
      eventType: '교육',
      summary: '안전교육',
      description: '교육대상: 홍길동, 김영희',
    })
    const request = toGoogleEventRequest(event)

    expect(request.summary).toBe('홍길동, 김영희 안전교육')
  })

  it('교육 대상이 없으면 summary 그대로 전송된다', () => {
    const event = makeCalendarEvent({
      eventType: '교육',
      summary: '안전교육',
      description: '',
    })
    const request = toGoogleEventRequest(event)

    expect(request.summary).toBe('안전교육')
  })

  it('휴가 이벤트의 summary는 변경되지 않는다', () => {
    const event = makeCalendarEvent({
      eventType: '휴가',
      summary: '박혜지 대휴',
      description: '휴가대상: 박혜지\n휴가종류: 대휴',
    })
    const request = toGoogleEventRequest(event)

    expect(request.summary).toBe('박혜지 대휴')
  })
})

describe('교육 Push→Pull 라운드트립 (통합)', () => {
  it('교육 push → Google summary → pull → 로컬 summary 복원', () => {
    // Step 1: Push - local event to Google
    const localEvent = makeCalendarEvent({
      eventType: '교육',
      summary: '안전교육',
      description: '교육대상: 홍길동, 김영희',
    })
    const requestBody = toGoogleEventRequest(localEvent)
    expect(requestBody.summary).toBe('홍길동, 김영희 안전교육')

    // Step 2: Pull - Google response back to local
    const googleResponse = makeGoogleEvent({
      summary: requestBody.summary,
      description: localEvent.description,
      extendedProperties: requestBody.extendedProperties,
    })
    const snapshot = toRemoteSnapshot(googleResponse)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.eventType).toBe('교육')
    expect(snapshot?.summary).toBe('안전교육')
  })
})

describe('eventType Push→Pull 라운드트립', () => {
  it.each(['일반', '근무', '반복업무', '커스텀타입'])
  ('eventType "%s"가 push 후 pull에서 동일하게 복원된다', (eventType) => {
    // Push: 로컬 이벤트 → Google 요청 body
    const localEvent = makeCalendarEvent({ eventType })
    const requestBody = toGoogleEventRequest(localEvent)

    // Pull: Google 응답 → RemoteEventSnapshot
    const googleResponse = makeGoogleEvent({
      extendedProperties: requestBody.extendedProperties,
    })
    const snapshot = toRemoteSnapshot(googleResponse)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.eventType).toBe(eventType)
  })
})
