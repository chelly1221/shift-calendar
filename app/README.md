# 교대근무 일정관리 (Shift Calendar)

Electron + React + Prisma(SQLite) 기반의 로컬 우선 Google Calendar 데스크톱 앱입니다.
교대 근무 팀 일정, 휴가, 교육, 반복업무 등을 통합 관리합니다.

## 핵심 원칙

- `renderer`는 UI/상태 표시만 담당
- 네트워크/OAuth/DB/동기화는 `main`에서 처리
- 로컬 DB를 즉시 반영하고 Outbox로 비동기 동기화
- 충돌은 `googleUpdatedAtUtc` vs `localEditedAtUtc` 최신 기준 자동 해결

## 폴더 구조

```
app/src/
├── main/
│   ├── ipc/            # IPC 채널/핸들러
│   ├── db/             # Prisma 저장소 (Event, Outbox, Setting)
│   ├── google/         # OAuth + Google Calendar API
│   ├── sync/           # Outbox 워커, Full/Delta 동기화
│   └── security/       # keytar 토큰 저장
├── preload/            # 안전한 브리지 API
├── renderer/
│   ├── components/     # EventModal, RecurrencePicker, SettingsModal
│   ├── pages/          # CalendarPage (메인 캘린더 뷰)
│   ├── state/          # Zustand 스토어 (useCalendarStore)
│   ├── styles/         # global.css
│   └── utils/          # parseEducationTargets, parseVacationInfo
└── shared/
    ├── calendar.ts     # Zod 스키마, 타입 정의, CalendarApi 인터페이스
    ├── expandRecurrence.ts  # 반복 일정 가상 인스턴스 확장
    ├── koreanHolidays.ts    # 대한민국 법정공휴일 판별
    └── rrule.ts        # RRULE 파싱/생성 유틸리티
```

## 실행

```bash
cd app
npm i
npm run dev
```

## 품질 검사

```bash
npm run lint
npm run type-check
npm test          # vitest 단위 테스트
```

## DB / Prisma

```bash
npx prisma migrate dev
npx prisma generate
```

스키마 변경 시 `migrate` + `generate`를 모두 수행합니다.

## 환경 변수

`.env` 예시:

```bash
DATABASE_URL="file:./dev.db"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_CALENDAR_ID="primary"
```

## 주요 기능

### 이벤트 타입
- **일반**: 기본 일정
- **근무**: 교대근무 일정 (주간/야간 팀 표시)
- **휴가**: 휴가 관리 (장기휴가, 연차, 대휴, 시간차 등)
- **교육**: 교육 일정 (대상자 지정)
- **반복업무**: 루틴 체크리스트 (완료 체크 가능)
- **공휴일**: 대한민국 법정공휴일 (Google 공휴일 캘린더 연동)

### 교대근무 관리
- 4개 팀(A/B/C/D) 기반 주간/야간 교대 스케줄
- 팀 모드: 1인(SINGLE) / 2인(PAIR) 선택
- 주간 근무자(day worker) 별도 관리
- 주말/공휴일 시 주간 근무자 자동 제외

### 반복 일정
- RRULE 기반 반복 (DAILY, WEEKLY, MONTHLY, YEARLY)
- BYDAY, BYMONTHDAY, BYSETPOS 지원
- 편집 범위: THIS(이 일정만), ALL(모든 일정), FUTURE(이후 일정)
- FUTURE 편집 시 시리즈 분할 (split) 처리
- 가상 인스턴스 확장으로 로컬 전용 반복 일정 렌더링

### 동기화
- Google OAuth 루프백(127.0.0.1) 연결/해제
- 다중 Google 캘린더 선택 지원
- Outbox 큐(패치 coalesce, 백오프 재시도)
- Full/Delta 동기화 + `410` 시 Full 재동기화
- eventType을 Google extendedProperties로 양방향 동기화

### 한국 공휴일
- Google 한국 공휴일 캘린더 연동
- 법정공휴일 키워드 기반 판별 (설날, 추석, 대체공휴일 등)
- 오프라인 fallback: 고정 날짜 공휴일(신정, 삼일절 등)

### UI
- FullCalendar 기반 월간 캘린더 뷰
- 커스텀 타이틀바 (최소화/최대화/닫기)
- 이벤트 인라인 제목 편집
- 루틴 완료 체크박스 (localStorage 저장)
- 마우스 휠 월 이동

## 테스트

```bash
npm test
```

Vitest를 사용합니다. 테스트 파일은 `*.test.ts` 패턴을 따릅니다.
현재 테스트 범위:
- eventType Push/Pull 라운드트립 (`calendarService.test.ts`)

## MVP에서 제외

- 드래그 이동 / 리사이즈
- 사용자 수동 충돌 선택 UI
