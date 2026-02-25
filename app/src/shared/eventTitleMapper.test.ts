import { describe, it, expect } from 'vitest'
import { inferEventMetadata, toGoogleSummary } from './eventTitleMapper'

describe('inferEventMetadata', () => {
  describe('eventType=일반 → 휴가 감지', () => {
    it('단일 대상 대휴를 휴가로 감지한다', () => {
      const result = inferEventMetadata('박혜지 대휴', '', '일반')
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('박혜지 대휴')
      expect(result.description).toContain('휴가대상: 박혜지')
      expect(result.description).toContain('휴가종류: 대휴')
    })

    it('복수 대상 연차를 휴가로 감지한다', () => {
      const result = inferEventMetadata('박혜지, 이종열 연차', '', '일반')
      expect(result.eventType).toBe('휴가')
      expect(result.description).toContain('휴가대상: 박혜지, 이종열')
      expect(result.description).toContain('휴가종류: 연차')
    })

    it('시간차(시간정보)를 휴가로 감지한다', () => {
      const result = inferEventMetadata('홍길동 시간차(09:00~13:00)', '', '일반')
      expect(result.eventType).toBe('휴가')
      expect(result.description).toContain('휴가대상: 홍길동')
      expect(result.description).toContain('휴가종류: 시간차(09:00~13:00)')
    })

    it('장기휴가를 휴가로 감지한다', () => {
      const result = inferEventMetadata('김영희 장기휴가', '', '일반')
      expect(result.eventType).toBe('휴가')
      expect(result.description).toContain('휴가종류: 장기휴가')
    })

    it('기존 description이 있으면 메타데이터 앞에 추가한다', () => {
      const result = inferEventMetadata('박혜지 대휴', '개인 사유', '일반')
      expect(result.eventType).toBe('휴가')
      expect(result.description).toBe('휴가대상: 박혜지\n휴가종류: 대휴\n개인 사유')
    })

    it('이미 메타데이터가 있으면 중복 주입하지 않는다', () => {
      const existing = '휴가대상: 박혜지\n휴가종류: 대휴'
      const result = inferEventMetadata('박혜지 대휴', existing, '일반')
      expect(result.eventType).toBe('휴가')
      // Should not have duplicate lines
      const targetCount = result.description.split('\n').filter((l) => l.startsWith('휴가대상:')).length
      expect(targetCount).toBe(1)
    })
  })

  describe('eventType=일반 → 교육 감지', () => {
    it('단일 대상 교육을 감지한다', () => {
      const result = inferEventMetadata('이종열 안전교육', '', '일반')
      expect(result.eventType).toBe('교육')
      expect(result.summary).toBe('안전교육')
      expect(result.description).toContain('교육대상: 이종열')
    })

    it('복수 대상 교육을 감지한다', () => {
      const result = inferEventMetadata('홍길동, 김영희 안전교육', '', '일반')
      expect(result.eventType).toBe('교육')
      expect(result.summary).toBe('안전교육')
      expect(result.description).toContain('교육대상: 홍길동, 김영희')
    })

    it('훈련 키워드도 교육으로 감지한다', () => {
      const result = inferEventMetadata('박혜지 소방훈련', '', '일반')
      expect(result.eventType).toBe('교육')
      expect(result.summary).toBe('소방훈련')
      expect(result.description).toContain('교육대상: 박혜지')
    })

    it('이미 교육대상 메타데이터가 있으면 중복 주입하지 않는다', () => {
      const existing = '교육대상: 이종열'
      const result = inferEventMetadata('이종열 안전교육', existing, '일반')
      expect(result.eventType).toBe('교육')
      const targetCount = result.description.split('\n').filter((l) => l.startsWith('교육대상:')).length
      expect(targetCount).toBe(1)
    })
  })

  describe('eventType=교육 라운드트립 정리', () => {
    it('Google summary에서 대상자 이름을 strip한다', () => {
      const desc = '교육대상: 홍길동, 김영희'
      const result = inferEventMetadata('홍길동, 김영희 안전교육', desc, '교육')
      expect(result.eventType).toBe('교육')
      expect(result.summary).toBe('안전교육')
    })

    it('대상자가 summary에 없으면 변경하지 않는다', () => {
      const desc = '교육대상: 이종열'
      const result = inferEventMetadata('안전교육', desc, '교육')
      expect(result.summary).toBe('안전교육')
    })
  })

  describe('eventType=휴가 메타데이터 보완', () => {
    it('description에 메타데이터가 없으면 보완한다', () => {
      const result = inferEventMetadata('박혜지 대휴', '', '휴가')
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('박혜지 대휴')
      expect(result.description).toContain('휴가대상: 박혜지')
      expect(result.description).toContain('휴가종류: 대휴')
    })

    it('이미 메타데이터가 있으면 변경하지 않는다', () => {
      const desc = '휴가대상: 박혜지\n휴가종류: 대휴'
      const result = inferEventMetadata('박혜지 대휴', desc, '휴가')
      expect(result.description).toBe(desc)
    })
  })

  describe('비매칭 케이스', () => {
    it('일반 미팅은 변경하지 않는다', () => {
      const result = inferEventMetadata('팀 미팅', '', '일반')
      expect(result.eventType).toBe('일반')
      expect(result.summary).toBe('팀 미팅')
      expect(result.description).toBe('')
    })

    it('영어 이름은 매칭하지 않는다', () => {
      const result = inferEventMetadata('John 대휴', '', '일반')
      expect(result.eventType).toBe('일반')
    })

    it('근무 타입은 변경하지 않는다', () => {
      const result = inferEventMetadata('A팀 주간', '', '근무')
      expect(result.eventType).toBe('근무')
      expect(result.summary).toBe('A팀 주간')
    })
  })
})

describe('toGoogleSummary', () => {
  it('교육 이벤트에 대상자를 앞에 붙인다', () => {
    const desc = '교육대상: 홍길동, 김영희\n기타 메모'
    const result = toGoogleSummary('안전교육', desc, '교육')
    expect(result).toBe('홍길동, 김영희 안전교육')
  })

  it('교육 대상이 없으면 summary 그대로 반환한다', () => {
    const result = toGoogleSummary('안전교육', '', '교육')
    expect(result).toBe('안전교육')
  })

  it('휴가 이벤트는 summary 그대로 반환한다', () => {
    const result = toGoogleSummary('박혜지 대휴', '휴가대상: 박혜지\n휴가종류: 대휴', '휴가')
    expect(result).toBe('박혜지 대휴')
  })

  it('일반 이벤트는 summary 그대로 반환한다', () => {
    const result = toGoogleSummary('팀 미팅', '', '일반')
    expect(result).toBe('팀 미팅')
  })
})

describe('교육 Push→Pull 라운드트립', () => {
  it('로컬 교육 → Google summary → 로컬 복원', () => {
    // Push: local → Google
    const localSummary = '안전교육'
    const localDesc = '교육대상: 홍길동, 김영희'
    const googleSummary = toGoogleSummary(localSummary, localDesc, '교육')
    expect(googleSummary).toBe('홍길동, 김영희 안전교육')

    // Pull: Google → local (with extendedProperties → eventType='교육')
    const inferred = inferEventMetadata(googleSummary, localDesc, '교육')
    expect(inferred.summary).toBe('안전교육')
    expect(inferred.eventType).toBe('교육')
  })
})

describe('휴가 Pull→Push 라운드트립', () => {
  it('Google "박혜지 대휴" → 로컬 휴가 → Google summary 유지', () => {
    // Pull: Google → local (no extendedProperties)
    const inferred = inferEventMetadata('박혜지 대휴', '', '일반')
    expect(inferred.eventType).toBe('휴가')
    expect(inferred.summary).toBe('박혜지 대휴')

    // Push: local → Google
    const googleSummary = toGoogleSummary(inferred.summary, inferred.description, inferred.eventType)
    expect(googleSummary).toBe('박혜지 대휴')
  })
})
