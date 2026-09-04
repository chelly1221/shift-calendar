import { describe, it, expect } from 'vitest'
import {
  inferEventMetadata,
  inferVacationFromSummary,
  inferVacationEvent,
  collectShiftMemberNames,
  buildShiftNameContext,
  toGoogleSummary,
  buildUniqueCharMap,
  parseShiftAbbreviations,
  stripShiftAbbreviations,
  resolveAbbreviationToName,
  parseSubstitutionBlocks,
  buildShiftGoogleSummary,
} from './eventTitleMapper'
import type { ShiftTeamAssignments } from './calendar'

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

  describe('eventType=일반 → 휴가 키워드 감지 (병가/공가/건강검진 등)', () => {
    const members = ['박혜지', '이종열', '홍길동', '김영희']

    it('병가 키워드를 휴가로 감지하고 팀원 이름을 대상자로 뽑는다', () => {
      const result = inferEventMetadata('홍길동 병가', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('홍길동 병가')
      expect(result.description).toContain('휴가대상: 홍길동')
      expect(result.description).toContain('휴가종류: 병가')
    })

    it('키워드가 이름 앞에 와도 팀원 이름을 인식한다', () => {
      const result = inferEventMetadata('이사공가 홍길동', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('홍길동 이사공가')
      expect(result.description).toContain('휴가대상: 홍길동')
      expect(result.description).toContain('휴가종류: 이사공가')
    })

    it('이름을 뺀 나머지에서 기호를 제거해 휴가종류로 쓴다', () => {
      const result = inferEventMetadata('홍길동 - 건강검진(오전)', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('홍길동 건강검진 오전')
      expect(result.description).toContain('휴가종류: 건강검진 오전')
    })

    it('공백 없이 붙은 팀원 이름도 인식한다', () => {
      const result = inferEventMetadata('박혜지연차', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('박혜지 연차')
      expect(result.description).toContain('휴가대상: 박혜지')
      expect(result.description).toContain('휴가종류: 연차')
    })

    it('여러 팀원 이름을 모두 대상자로 뽑는다', () => {
      const result = inferEventMetadata('박혜지/이종열 공가', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('박혜지, 이종열 공가')
      expect(result.description).toContain('휴가대상: 박혜지, 이종열')
      expect(result.description).toContain('휴가종류: 공가')
    })

    it('이름이 없으면 대상자 없이 휴가종류만 넣는다', () => {
      const result = inferEventMetadata('건강검진 안내', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('건강검진 안내')
      expect(result.description).not.toContain('휴가대상:')
      expect(result.description).toContain('휴가종류: 건강검진 안내')
    })

    it('오전/오후 같은 수식어는 이름으로 오인하지 않는다', () => {
      const result = inferEventMetadata('오전 반차', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.description).not.toContain('휴가대상:')
      expect(result.description).toContain('휴가종류: 오전 반차')
    })

    it('명단에 없는 한글 이름은 선행 토큰 휴리스틱으로 인식한다', () => {
      const result = inferEventMetadata('최민수 대휴', '', '일반', { memberNames: members })
      expect(result.eventType).toBe('휴가')
      expect(result.description).toContain('휴가대상: 최민수')
      expect(result.description).toContain('휴가종류: 대휴')
    })

    it('시간차(HH:MM~HH:MM)는 시간 정보를 보존한다', () => {
      const result = inferEventMetadata('홍길동 시간차(09:00~13:00)', '', '일반', { memberNames: members })
      expect(result.summary).toBe('홍길동 시간차(09:00~13:00)')
      expect(result.description).toContain('휴가종류: 시간차(09:00~13:00)')
    })

    it('긴 이름이 짧은 이름을 포함해도 긴 이름을 우선 매칭한다', () => {
      const result = inferVacationFromSummary('이수진 연차', { memberNames: ['이수', '이수진'] })
      expect(result?.targets).toEqual(['이수진'])
      expect(result?.vacationType).toBe('연차')
    })

    it('inferVacationEvent는 키워드가 없으면 null', () => {
      expect(inferVacationEvent('팀 미팅', '', { memberNames: members })).toBeNull()
    })

    it('inferVacationEvent는 기존 description 앞에 메타데이터를 넣는다', () => {
      const result = inferVacationEvent('홍길동 병가', '시각: 09:00~12:00', { memberNames: members })
      expect(result?.description).toBe('휴가대상: 홍길동\n휴가종류: 병가\n시각: 09:00~12:00')
    })
  })

  describe('실제 캘린더 표기 — 괄호·약어·붙여쓰기', () => {
    // 실제 설정과 같은 구성: 팀원 10명 + 사용자 지정 1자 약어
    const context = buildShiftNameContext({
      teams: {
        A: ['윤태연', '이명섭'],
        B: ['서상현', '이상승'],
        C: ['박혜지', '윤형집'],
        D: ['신유철', '김수헌'],
      },
      dayWorkers: ['이종열', '채정원'],
      abbreviations: {
        박혜지: '혜', 윤형집: '집', 김수헌: '헌', 신유철: '신', 서상현: '서',
        이상승: '승', 이명섭: '섭', 윤태연: '연', 채정원: '채', 이종열: '열',
      },
    })
    const infer = (summary: string) => inferEventMetadata(summary, '', '일반', context)

    it('"병가(이종열)" — 괄호 속 팀원 이름', () => {
      const result = infer('병가(이종열)')
      expect(result.eventType).toBe('휴가')
      expect(result.summary).toBe('이종열 병가')
      expect(result.description).toBe('휴가대상: 이종열\n휴가종류: 병가')
    })

    it('"이명섭(이사공가)" — 괄호 속 휴가 종류', () => {
      const result = infer('이명섭(이사공가)')
      expect(result.summary).toBe('이명섭 이사공가')
      expect(result.description).toBe('휴가대상: 이명섭\n휴가종류: 이사공가')
    })

    it('"건강검진(채정원)"', () => {
      const result = infer('건강검진(채정원)')
      expect(result.summary).toBe('채정원 건강검진')
      expect(result.description).toContain('휴가종류: 건강검진')
    })

    it('"신 대휴" — 사용자 지정 약어', () => {
      const result = infer('신 대휴')
      expect(result.summary).toBe('신유철 대휴')
      expect(result.description).toBe('휴가대상: 신유철\n휴가종류: 대휴')
    })

    it('"채연차" — 약어와 키워드를 붙여 씀', () => {
      const result = infer('채연차')
      expect(result.summary).toBe('채정원 연차')
      expect(result.description).toContain('휴가종류: 연차')
    })

    it('"채오후반차" — 약어 + 수식어 + 키워드', () => {
      const result = infer('채오후반차')
      expect(result.summary).toBe('채정원 오후반차')
      expect(result.description).toContain('휴가종류: 오후반차')
    })

    it('"혜 시간차 (~11:30)" — 공백 있는 괄호도 시간차(…)로 정규화', () => {
      const result = infer('혜 시간차 (~11:30)')
      expect(result.summary).toBe('박혜지 시간차(~11:30)')
      expect(result.description).toContain('휴가종류: 시간차(~11:30)')
    })

    it('"집 시간차(9~11)"', () => {
      const result = infer('집 시간차(9~11)')
      expect(result.summary).toBe('윤형집 시간차(9~11)')
    })

    it('"헌 시간차(3시부터)"', () => {
      const result = infer('헌 시간차(3시부터)')
      expect(result.summary).toBe('김수헌 시간차(3시부터)')
    })

    it('"소장님, 윤형집 대휴" — 명단 이름 + 콤마로 구분된 비명단 이름', () => {
      const result = infer('소장님, 윤형집 대휴')
      expect(result.description).toBe('휴가대상: 윤형집, 소장님\n휴가종류: 대휴')
      expect(result.summary).toBe('윤형집, 소장님 대휴')
    })

    it('"소장님 시간차(16:30~)" — 비명단 이름 + 시간차', () => {
      const result = infer('소장님 시간차(16:30~)')
      expect(result.summary).toBe('소장님 시간차(16:30~)')
    })

    it('"서상현 대휴, 이상승 휴가" — 두 명단 이름', () => {
      const result = infer('서상현 대휴, 이상승 휴가 ')
      expect(result.description).toContain('휴가대상: 서상현, 이상승')
      expect(result.description).toContain('휴가종류: 대휴 휴가')
    })

    it('"연차 신청" — 키워드 첫 글자(연=윤태연 약어)를 약어로 오인하지 않는다', () => {
      const result = infer('연차 신청')
      expect(result.eventType).toBe('휴가')
      expect(result.description).not.toContain('휴가대상:')
      expect(result.description).toContain('휴가종류: 연차 신청')
    })

    it('"원 대휴" — 약어가 아닌 1자는 이름으로 보지 않는다', () => {
      const result = infer('원 대휴')
      expect(result.description).not.toContain('휴가대상:')
      expect(result.description).toContain('휴가종류: 원 대휴')
    })

    it('"박혜지 결혼 휴가" — 명단 이름이 있으면 수식어를 이름으로 오인하지 않는다', () => {
      const result = infer('박혜지 결혼 휴가')
      expect(result.description).toBe('휴가대상: 박혜지\n휴가종류: 결혼 휴가')
    })

    it('"채 대휴" 는 채정원 (약어 우선, 채 가 포함된 다른 이름 없음)', () => {
      const result = infer('채 대휴')
      expect(result.summary).toBe('채정원 대휴')
    })

    it('휴가 타입 보완도 약어를 인식한다', () => {
      const result = inferEventMetadata('신 연차', '', '휴가', context)
      expect(result.summary).toBe('신 연차')
      expect(result.description).toBe('휴가대상: 신유철\n휴가종류: 연차')
    })
  })

  describe('eventType=휴가 메타데이터 보완 (키워드 기반)', () => {
    it('병가처럼 프리셋이 아닌 종류도 보완한다', () => {
      const result = inferEventMetadata('홍길동 병가', '', '휴가', { memberNames: ['홍길동'] })
      expect(result.summary).toBe('홍길동 병가')
      expect(result.description).toContain('휴가대상: 홍길동')
      expect(result.description).toContain('휴가종류: 병가')
    })
  })

  describe('비매칭 케이스', () => {
    it('일반 미팅은 변경하지 않는다', () => {
      const result = inferEventMetadata('팀 미팅', '', '일반')
      expect(result.eventType).toBe('일반')
      expect(result.summary).toBe('팀 미팅')
      expect(result.description).toBe('')
    })

    it('영어 이름도 선행 토큰이면 대상자로 인식한다', () => {
      const result = inferEventMetadata('John 대휴', '', '일반')
      expect(result.eventType).toBe('휴가')
      expect(result.description).toContain('휴가대상: John')
      expect(result.description).toContain('휴가종류: 대휴')
    })

    it('휴가 키워드가 없는 이름+텍스트는 변경하지 않는다', () => {
      const result = inferEventMetadata('홍길동 회식', '', '일반')
      expect(result.eventType).toBe('일반')
      expect(result.summary).toBe('홍길동 회식')
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

describe('buildShiftNameContext', () => {
  it('팀원 이름과 약어를 함께 담는다', () => {
    const context = buildShiftNameContext({
      teams: { A: ['박혜지'], B: [], C: [], D: [] },
      dayWorkers: ['이종열'],
      abbreviations: { 박혜지: '혜' },
    })
    expect(context.memberNames).toEqual(['박혜지', '이종열'])
    expect(context.abbreviations).toEqual({ 박혜지: '혜' })
  })
})

describe('collectShiftMemberNames', () => {
  it('팀원과 주간 근무자를 공백 정리·중복 제거해 모은다', () => {
    const names = collectShiftMemberNames({
      teams: { A: ['박혜지 ', '이종열'], B: ['홍길동'], C: [''], D: ['이종열'] },
      dayWorkers: [' 김영희', '홍길동'],
    })
    expect(names).toEqual(['박혜지', '이종열', '홍길동', '김영희'])
  })
})

// --- Shift abbreviation tests ---

describe('buildUniqueCharMap', () => {
  it('고유 글자를 선택한다', () => {
    const map = buildUniqueCharMap(['채정원', '김영희', '이종열'])
    expect(map.get('채정원')).toBe('채')
    expect(map.get('김영희')).toBe('김')
    expect(map.get('이종열')).toBe('이')
  })

  it('빈 배열이면 빈 Map을 반환한다', () => {
    const map = buildUniqueCharMap([])
    expect(map.size).toBe(0)
  })

  it('단일 이름이면 첫 글자를 선택한다', () => {
    const map = buildUniqueCharMap(['홍길동'])
    expect(map.get('홍길동')).toBe('홍')
  })

  it('공유 글자가 있으면 소유자가 적은 글자로 폴백한다', () => {
    // 김민수, 김민지 → '김','민' 공유, '수' 고유, '지' 고유
    const map = buildUniqueCharMap(['김민수', '김민지'])
    expect(map.get('김민수')).toBe('수')
    expect(map.get('김민지')).toBe('지')
  })

  it('모든 글자가 공유되면 서로 다른 글자를 할당한다', () => {
    // '가나', '나가' → '가'(2), '나'(2) 모두 공유지만 서로 다른 글자를 할당
    const map = buildUniqueCharMap(['가나', '나가'])
    expect(map.size).toBe(2)
    expect(map.get('가나')).toBeDefined()
    expect(map.get('나가')).toBeDefined()
    expect(map.get('가나')).not.toBe(map.get('나가'))
  })

  it('3명이 모든 글자를 공유하면 가능한 한 서로 다른 글자를 할당한다', () => {
    // 가나, 나다, 가다 → 가(2), 나(2), 다(2) 모두 count=2
    const map = buildUniqueCharMap(['가나', '나다', '가다'])
    expect(map.size).toBe(3)
    for (const name of ['가나', '나다', '가다']) {
      expect(map.has(name)).toBe(true)
    }
    // 3명에게 2글자씩이므로 최소 2개는 서로 다른 글자
    const chars = [...map.values()]
    const uniqueChars = new Set(chars)
    expect(uniqueChars.size).toBeGreaterThanOrEqual(2)
  })

  it('중복 이름이 있으면 하나로 취급한다', () => {
    const map = buildUniqueCharMap(['홍길동', '홍길동'])
    expect(map.size).toBe(1)
    expect(map.get('홍길동')).toBe('홍')
  })

  it('단일 글자 이름도 처리한다', () => {
    const map = buildUniqueCharMap(['김'])
    expect(map.get('김')).toBe('김')
  })

  it('2명이 동일 글자셋이면 서로 다른 글자를 할당한다 (collision 방지)', () => {
    const map = buildUniqueCharMap(['김민수', '김민지'])
    expect(map.get('김민수')).toBe('수')
    expect(map.get('김민지')).toBe('지')
    // 서로 달라야 함
    expect(map.get('김민수')).not.toBe(map.get('김민지'))
  })

  it('커스텀 오버라이드가 우선 적용된다', () => {
    const map = buildUniqueCharMap(['채정원', '김영희'], { '채정원': '원' })
    expect(map.get('채정원')).toBe('원')
    expect(map.get('김영희')).toBe('김')
  })

  it('커스텀 오버라이드 글자가 다른 이름의 후보에서 제외된다', () => {
    // '채'를 김영희에게 오버라이드하면 채정원은 다른 글자를 선택해야 함
    const map = buildUniqueCharMap(['채정원', '김영희'], { '김영희': '채' })
    expect(map.get('김영희')).toBe('채')
    expect(map.get('채정원')).not.toBe('채')
  })

  it('커스텀 오버라이드에 allNames에 없는 이름이면 무시한다', () => {
    const map = buildUniqueCharMap(['채정원'], { '없는사람': '홍' })
    expect(map.has('없는사람')).toBe(false)
    expect(map.get('채정원')).toBe('채')
  })

  it('빈 오버라이드 객체면 기존 동작과 동일하다', () => {
    const map = buildUniqueCharMap(['채정원', '김영희'], {})
    expect(map.get('채정원')).toBe('채')
    expect(map.get('김영희')).toBe('김')
  })

  it('undefined 오버라이드면 기존 동작과 동일하다', () => {
    const map = buildUniqueCharMap(['채정원', '김영희'], undefined)
    expect(map.get('채정원')).toBe('채')
    expect(map.get('김영희')).toBe('김')
  })
})

describe('parseShiftAbbreviations', () => {
  it('단일 약어를 파싱한다', () => {
    const result = parseShiftAbbreviations('A(채)/B')
    expect(result.get('A')).toEqual(['채'])
    expect(result.has('B')).toBe(false)
  })

  it('복수 약어를 파싱한다', () => {
    const result = parseShiftAbbreviations('A(채,김)/B')
    expect(result.get('A')).toEqual(['채', '김'])
  })

  it('약어 없는 경우 빈 Map을 반환한다', () => {
    const result = parseShiftAbbreviations('A/B')
    expect(result.size).toBe(0)
  })

  it('양쪽 팀 모두 약어가 있는 경우를 파싱한다', () => {
    const result = parseShiftAbbreviations('A(채)/B(김)')
    expect(result.get('A')).toEqual(['채'])
    expect(result.get('B')).toEqual(['김'])
  })

  it('빈 괄호 A()/B는 약어 없는 것으로 처리한다', () => {
    const result = parseShiftAbbreviations('A()/B')
    expect(result.size).toBe(0)
  })

  it('공백만 있는 괄호 A( )/B는 약어 없는 것으로 처리한다', () => {
    const result = parseShiftAbbreviations('A( )/B')
    expect(result.size).toBe(0)
  })

  it('A-D 외의 문자는 무시한다', () => {
    const result = parseShiftAbbreviations('E(채)/F(김)')
    expect(result.size).toBe(0)
  })

  it('추가 텍스트가 있는 summary를 파싱한다', () => {
    const result = parseShiftAbbreviations('A(채)/B 주간/야간')
    expect(result.get('A')).toEqual(['채'])
    expect(result.has('B')).toBe(false)
  })

  it('빈 문자열이면 빈 Map을 반환한다', () => {
    const result = parseShiftAbbreviations('')
    expect(result.size).toBe(0)
  })
})

describe('stripShiftAbbreviations', () => {
  it('약어를 제거한다', () => {
    expect(stripShiftAbbreviations('A(채)/B')).toBe('A/B')
  })

  it('복수 약어를 제거한다', () => {
    expect(stripShiftAbbreviations('A(채,김)/B(이)')).toBe('A/B')
  })

  it('약어 없으면 그대로 반환한다', () => {
    expect(stripShiftAbbreviations('A/B')).toBe('A/B')
  })

  it('추가 텍스트가 있는 summary에서 약어만 제거한다', () => {
    expect(stripShiftAbbreviations('A(채)/B 주간/야간')).toBe('A/B 주간/야간')
  })

  it('빈 문자열이면 빈 문자열을 반환한다', () => {
    expect(stripShiftAbbreviations('')).toBe('')
  })

  it('약어 없는 복잡한 summary는 그대로 반환한다', () => {
    expect(stripShiftAbbreviations('C/D 야간근무')).toBe('C/D 야간근무')
  })
})

describe('resolveAbbreviationToName', () => {
  const allNames = ['채정원', '김영희', '이종열']

  it('고유 글자로 이름을 찾는다', () => {
    expect(resolveAbbreviationToName('채', allNames)).toBe('채정원')
  })

  it('매칭 안되면 null을 반환한다', () => {
    expect(resolveAbbreviationToName('홍', allNames)).toBeNull()
  })

  it('중복 글자면 첫 번째 매칭을 반환한다', () => {
    const names = ['채정원', '정민수']
    expect(resolveAbbreviationToName('정', names)).toBe('채정원') // 2명 모두 '정' 포함 → 첫 번째 매칭
    expect(resolveAbbreviationToName('채', names)).toBe('채정원')
  })

  it('빈 배열이면 null을 반환한다', () => {
    expect(resolveAbbreviationToName('채', [])).toBeNull()
  })

  it('이름의 중간/끝 글자로도 매칭한다', () => {
    expect(resolveAbbreviationToName('원', allNames)).toBe('채정원')
    expect(resolveAbbreviationToName('희', allNames)).toBe('김영희')
  })

  it('customOverrides에서 이름에 없는 글자로도 매칭한다', () => {
    const overrides = { '채정원': 'X', '김영희': 'Y' }
    expect(resolveAbbreviationToName('X', allNames, overrides)).toBe('채정원')
    expect(resolveAbbreviationToName('Y', allNames, overrides)).toBe('김영희')
  })

  it('customOverrides가 일반 매칭보다 우선한다', () => {
    // '채' 는 채정원의 이름에도 있지만, override로 다른 사람에게 배정 가능
    const overrides = { '김영희': '채' }
    expect(resolveAbbreviationToName('채', allNames, overrides)).toBe('김영희')
  })

  it('customOverrides에 없는 글자는 기존 로직으로 fallback', () => {
    const overrides = { '채정원': 'X' }
    expect(resolveAbbreviationToName('희', allNames, overrides)).toBe('김영희')
  })
})

describe('parseSubstitutionBlocks', () => {
  it('대체근무 블록을 파싱한다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const result = parseSubstitutionBlocks(desc)
    expect(result).toEqual([
      { substitute: '홍길동', type: '대리근무', original: '채정원' },
    ])
  })

  it('복수 블록을 파싱한다', () => {
    const desc = [
      '대체근무자: 홍길동',
      '근무종류: 대리근무',
      '원근무자: 채정원',
      '대체근무자: 박서준',
      '근무종류: 대체근무',
      '원근무자: 김영희',
    ].join('\n')
    const result = parseSubstitutionBlocks(desc)
    expect(result).toHaveLength(2)
    expect(result[0].substitute).toBe('홍길동')
    expect(result[1].substitute).toBe('박서준')
  })

  it('빈 description이면 빈 배열을 반환한다', () => {
    expect(parseSubstitutionBlocks('')).toEqual([])
  })

  it('불완전한 블록은 무시한다', () => {
    const desc = '대체근무자: 홍길동\n기타 텍스트'
    expect(parseSubstitutionBlocks(desc)).toEqual([])
  })

  it('근무종류가 대리/대체 외이면 무시한다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 임시근무\n원근무자: 채정원'
    expect(parseSubstitutionBlocks(desc)).toEqual([])
  })

  it('블록 사이에 일반 텍스트가 있어도 파싱한다', () => {
    const desc = [
      '메모 내용',
      '대체근무자: 홍길동',
      '근무종류: 대리근무',
      '원근무자: 채정원',
      '기타 텍스트',
    ].join('\n')
    const result = parseSubstitutionBlocks(desc)
    expect(result).toHaveLength(1)
    expect(result[0].substitute).toBe('홍길동')
  })

  it('앞뒤 공백이 있는 라인도 처리한다', () => {
    const desc = '  대체근무자: 홍길동  \n  근무종류: 대리근무  \n  원근무자: 채정원  '
    const result = parseSubstitutionBlocks(desc)
    expect(result).toHaveLength(1)
    expect(result[0].substitute).toBe('홍길동')
    expect(result[0].original).toBe('채정원')
  })

  it('\\r\\n 줄바꿈도 처리한다', () => {
    const desc = '대체근무자: 홍길동\r\n근무종류: 대리근무\r\n원근무자: 채정원'
    const result = parseSubstitutionBlocks(desc)
    expect(result).toHaveLength(1)
  })

  it('원근무자만 있고 대체근무자가 없으면 무시한다', () => {
    const desc = '원근무자: 채정원\n근무종류: 대리근무'
    expect(parseSubstitutionBlocks(desc)).toEqual([])
  })
})

describe('buildShiftGoogleSummary', () => {
  const teams: ShiftTeamAssignments = {
    A: ['채정원', '박혜지'],
    B: ['김영희', '이종열'],
    C: ['홍길동', '정민수'],
    D: ['한소희', '유재석'],
  }
  const allNames = ['채정원', '박혜지', '김영희', '이종열', '홍길동', '정민수', '한소희', '유재석']

  it('대체근무가 있으면 약어를 삽입한다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    expect(result).toContain('A(')
    expect(result).toContain(')/B')
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('A')).toBeDefined()
  })

  it('대체근무가 없으면 원본 그대로 반환한다', () => {
    const result = buildShiftGoogleSummary('A/B', '', teams, allNames)
    expect(result).toBe('A/B')
  })

  it('기존 약어가 있어도 멱등하게 동작한다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const first = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    const second = buildShiftGoogleSummary(first, desc, teams, allNames)
    expect(second).toBe(first)
  })

  it('allNames가 비어있으면 clean summary 반환한다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const result = buildShiftGoogleSummary('A/B', desc, teams, [])
    expect(result).toBe('A/B')
  })

  it('PAIR 모드: 한 팀에 2명 대체 시 콤마 구분', () => {
    const desc = [
      '대체근무자: 홍길동',
      '근무종류: 대리근무',
      '원근무자: 채정원',
      '대체근무자: 정민수',
      '근무종류: 대체근무',
      '원근무자: 박혜지',
    ].join('\n')
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('A')?.length).toBe(2)
    // 콤마 구분 형태 확인
    expect(result).toMatch(/A\([^)]+,[^)]+\)/)
  })

  it('원근무자가 팀에 없으면 약어를 삽입하지 않는다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 알수없음'
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    expect(result).toBe('A/B')
  })

  it('대체근무자가 allNames에 없으면 약어를 삽입하지 않는다', () => {
    const desc = '대체근무자: 외부인\n근무종류: 대리근무\n원근무자: 채정원'
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    // charMap에 '외부인'이 없으므로 약어 삽입 불가
    expect(result).toBe('A/B')
  })

  it('빈 teams이면 약어를 삽입하지 않는다', () => {
    const emptyTeams: ShiftTeamAssignments = { A: [], B: [], C: [], D: [] }
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const result = buildShiftGoogleSummary('A/B', desc, emptyTeams, allNames)
    // 원근무자 채정원이 빈 teams에서 찾을 수 없으므로 약어 삽입 불가
    expect(result).toBe('A/B')
  })

  it('추가 텍스트가 있는 summary에 약어를 삽입한다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const result = buildShiftGoogleSummary('A/B 주간/야간', desc, teams, allNames)
    expect(stripShiftAbbreviations(result)).toBe('A/B 주간/야간')
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('A')).toBeDefined()
  })

  it('뱃지 삭제(description에서 메타 제거) 후 push하면 clean summary 반환', () => {
    // description에서 대체근무 블록이 제거된 상태
    const descAfterDeletion = '일반 메모 텍스트'
    const result = buildShiftGoogleSummary('A(채)/B', descAfterDeletion, teams, allNames)
    expect(result).toBe('A/B')
  })

  it('같은 팀 같은 원근무자에 대해 동일 대체자 중복 시 약어 하나만', () => {
    const desc = [
      '대체근무자: 홍길동',
      '근무종류: 대리근무',
      '원근무자: 채정원',
      '대체근무자: 홍길동',
      '근무종류: 대체근무',
      '원근무자: 박혜지',
    ].join('\n')
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    const abbrevs = parseShiftAbbreviations(result)
    const chars = abbrevs.get('A') ?? []
    // 홍길동의 약어가 중복 없이 하나만 존재
    const uniqueChars = [...new Set(chars)]
    expect(chars.length).toBe(uniqueChars.length)
  })

  it('C/D 팀에 대체근무가 있는 경우에도 동작한다', () => {
    const desc = '대체근무자: 채정원\n근무종류: 대리근무\n원근무자: 한소희'
    const result = buildShiftGoogleSummary('C/D', desc, teams, allNames)
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('D')).toBeDefined()
    expect(stripShiftAbbreviations(result)).toBe('C/D')
  })

  it('summary에 팀 글자가 비팀 위치에 있어도 팀 위치에만 약어 삽입', () => {
    // 'A/B A동' — 뒤의 'A동'은 건드리지 않아야 함
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const result = buildShiftGoogleSummary('A/B A동', desc, teams, allNames)
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('A')).toBeDefined()
    // 'A동'은 그대로 보존
    expect(result).toContain('A동')
    // '/' 앞의 A에만 약어가 삽입됨
    expect(result).toMatch(/^A\([^)]+\)\/B A동$/)
  })

  it('양쪽 팀 모두 대체근무가 있으면 양쪽에 약어 삽입', () => {
    const desc = [
      '대체근무자: 홍길동',
      '근무종류: 대리근무',
      '원근무자: 채정원',
      '대체근무자: 한소희',
      '근무종류: 대체근무',
      '원근무자: 김영희',
    ].join('\n')
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('A')).toBeDefined()
    expect(abbrevs.get('B')).toBeDefined()
  })

  it('커스텀 오버라이드가 약어에 반영된다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const overrides = { '홍길동': '동' }
    const result = buildShiftGoogleSummary('A/B', desc, teams, allNames, overrides)
    const abbrevs = parseShiftAbbreviations(result)
    expect(abbrevs.get('A')).toContain('동')
  })

  it('커스텀 오버라이드 undefined이면 기존 동작과 동일하다', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const withOverride = buildShiftGoogleSummary('A/B', desc, teams, allNames, undefined)
    const without = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    expect(withOverride).toBe(without)
  })
})

describe('근무 Push→Pull 라운드트립', () => {
  const teams: ShiftTeamAssignments = {
    A: ['채정원', '박혜지'],
    B: ['김영희', '이종열'],
    C: ['홍길동', '정민수'],
    D: ['한소희', '유재석'],
  }
  const allNames = ['채정원', '박혜지', '김영희', '이종열', '홍길동', '정민수', '한소희', '유재석']

  it('push A/B + 뱃지 → A(x)/B → pull A/B + 뱃지 복원', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'

    // Push: build compact summary
    const googleSummary = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    expect(googleSummary).not.toBe('A/B')

    // Pull: strip abbreviations for display
    const displayLabel = stripShiftAbbreviations(googleSummary)
    expect(displayLabel).toBe('A/B')

    // Pull: parse abbreviations for badge fallback
    const abbrevs = parseShiftAbbreviations(googleSummary)
    expect(abbrevs.size).toBeGreaterThan(0)

    // Resolve abbreviation back to name
    for (const [, chars] of abbrevs) {
      for (const char of chars) {
        const resolved = resolveAbbreviationToName(char, allNames)
        expect(resolved).toBe('홍길동')
      }
    }
  })

  it('PAIR 모드 라운드트립: 2명 대체 → push → pull 복원', () => {
    const desc = [
      '대체근무자: 홍길동',
      '근무종류: 대리근무',
      '원근무자: 채정원',
      '대체근무자: 정민수',
      '근무종류: 대체근무',
      '원근무자: 박혜지',
    ].join('\n')

    const googleSummary = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    const displayLabel = stripShiftAbbreviations(googleSummary)
    expect(displayLabel).toBe('A/B')

    const abbrevs = parseShiftAbbreviations(googleSummary)
    expect(abbrevs.get('A')?.length).toBe(2)

    // 각 약어가 올바른 이름으로 resolve
    const resolved = (abbrevs.get('A') ?? []).map((c) => resolveAbbreviationToName(c, allNames))
    expect(resolved).toContain('홍길동')
    expect(resolved).toContain('정민수')
  })

  it('뱃지 삭제 후 라운드트립: clean A/B 유지', () => {
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'

    // First push with badge
    const withBadge = buildShiftGoogleSummary('A/B', desc, teams, allNames)
    expect(withBadge).not.toBe('A/B')

    // Badge deleted → description cleared
    const noBadge = buildShiftGoogleSummary(withBadge, '', teams, allNames)
    expect(noBadge).toBe('A/B')

    // Pull the clean result
    expect(stripShiftAbbreviations(noBadge)).toBe('A/B')
    expect(parseShiftAbbreviations(noBadge).size).toBe(0)
  })

  it('외부 입력 A(채)/B, description 없음 → 약어로 뱃지 파싱', () => {
    // 구글 캘린더에서 직접 입력된 경우 description이 없을 수 있음
    const externalSummary = 'A(채)/B'

    const displayLabel = stripShiftAbbreviations(externalSummary)
    expect(displayLabel).toBe('A/B')

    const abbrevs = parseShiftAbbreviations(externalSummary)
    expect(abbrevs.get('A')).toEqual(['채'])

    const resolved = resolveAbbreviationToName('채', allNames)
    expect(resolved).toBe('채정원')
  })

  it('약어 글자가 아무 멤버와 안 맞으면 resolve null', () => {
    const externalSummary = 'A(ㄱ)/B'
    const abbrevs = parseShiftAbbreviations(externalSummary)
    expect(abbrevs.get('A')).toEqual(['ㄱ'])
    // ㄱ 은 아무 이름에도 없음
    const resolved = resolveAbbreviationToName('ㄱ', allNames)
    expect(resolved).toBeNull()
  })

  it('description 뱃지와 약어 뱃지가 모두 있으면 description 기반이 우선', () => {
    // description에 대체근무 정보가 있고, summary에도 약어가 있는 경우
    const desc = '대체근무자: 홍길동\n근무종류: 대리근무\n원근무자: 채정원'
    const summaryWithAbbrev = 'A(홍)/B'

    // description 파싱 결과가 있으면 약어 뱃지는 스킵해야 함 (CalendarPage 로직)
    const substitutions = parseSubstitutionBlocks(desc)
    expect(substitutions.length).toBeGreaterThan(0)

    // 약어 파싱도 가능
    const abbrevs = parseShiftAbbreviations(summaryWithAbbrev)
    expect(abbrevs.get('A')).toBeDefined()

    // 두 소스 모두 존재 → CalendarPage에서 description 우선
  })

  it('멱등성: push 결과를 다시 push해도 동일', () => {
    const desc = [
      '대체근무자: 한소희',
      '근무종류: 대체근무',
      '원근무자: 김영희',
    ].join('\n')

    const first = buildShiftGoogleSummary('C/D', desc, teams, allNames)
    const second = buildShiftGoogleSummary(first, desc, teams, allNames)
    const third = buildShiftGoogleSummary(second, desc, teams, allNames)
    expect(first).toBe(second)
    expect(second).toBe(third)
  })
})
