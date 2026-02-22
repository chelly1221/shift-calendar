# Repository Guidelines

## Project Structure & Module Organization
이 저장소는 Electron 기반 로컬 교대근무 일정관리 앱입니다. 핵심 구조는 `app/src` 아래에 고정합니다.

- `app/src/main/ipc`: IPC 채널 정의 및 요청 라우팅
- `app/src/main/db`: Prisma + SQLite 캐시/Outbox 리포지토리
- `app/src/main/google`: OAuth 및 Google Calendar API 래퍼
- `app/src/main/sync`: Outbox 워커, 재시도(backoff), 충돌 해결
- `app/src/main/security`: 토큰 저장(`keytar`)
- `app/src/preload`: 안전한 브리지 API
- `app/src/renderer`: React UI (`CalendarPage`, `EventModal`, `RecurrencePicker`, `SettingsModal`)
- `app/src/renderer/utils`: UI 유틸리티 (`parseEducationTargets`, `parseVacationInfo`)
- `app/src/shared`: 공유 타입/스키마 (`calendar.ts`), 반복 일정 확장(`expandRecurrence.ts`), 공휴일 판별(`koreanHolidays.ts`), RRULE 유틸리티(`rrule.ts`)

원칙: 네트워크/토큰/DB 로직은 `main`에 두고, `renderer`는 UI와 상태 표시만 담당합니다.

## Event Types
앱은 다음 이벤트 타입을 지원합니다:
- `일반`: 기본 일정
- `근무`: 교대근무 (주간/야간 팀 배정)
- `휴가`: 휴가 관리 (대상자, 종류 포함)
- `교육`: 교육 일정 (대상자 지정)
- `반복업무`: 루틴 체크리스트
- `공휴일`: 대한민국 법정공휴일

eventType은 Google extendedProperties.private.shiftCalendarEventType으로 양방향 동기화됩니다.

## Build, Test, and Development Commands
- `npm i`: 의존성 설치
- `npm run dev`: Electron + Vite 개발 실행
- `npm run lint`: 정적 검사
- `npm run type-check`: TypeScript 엄격 타입 검사
- `npm test`: Vitest 단위 테스트 실행
- `npm run build`: 프로덕션 빌드
- `npx prisma migrate deploy`: 배포 마이그레이션 적용

스키마 변경 시 `npx prisma generate`를 함께 실행하고 PR 설명에 반영합니다.

## Coding Style & Naming Conventions
- TypeScript `strict` 유지, `any` 사용 최소화
- 시간 규칙: DB에는 UTC 저장, UI/요청에는 `timeZone` 명시
- 네이밍: 컴포넌트/타입 `PascalCase`, 함수/변수 `camelCase`
- IPC 입력/출력은 `zod`로 검증
- 반복 일정은 RRULE + 예외(override/cancelled instance)까지 처리
- 참석자 이메일 및 `sendUpdates` 플래그를 명시적으로 제어
- description 필드에 구조화된 메타데이터 저장 시 접두사 패턴 사용 (예: `교육대상: `, `휴가대상: `, `휴가종류: `, `시각: `)

## Recurrence Handling
- RRULE 파싱/생성은 `shared/rrule.ts`에서 처리
- 반복 일정 가상 인스턴스 확장은 `shared/expandRecurrence.ts`에서 처리
- 가상 인스턴스 localId: `virtual::{masterLocalId}::{occurrenceStartUtcIso}`
- 편집 범위: THIS(단일 인스턴스), ALL(전체 시리즈), FUTURE(이후 시리즈 분할)
- FUTURE 편집 시 마스터 RRULE에 UNTIL 추가 후 새 시리즈 생성

## Shift Management
- 4개 팀(A/B/C/D) 기반 교대 근무
- 팀 모드: SINGLE(1인) / PAIR(2인)
- 주간 근무자(dayWorkers) 별도 관리
- 설정은 `ShiftSettings` 스키마로 관리

## Sync & Conflict Rules
로컬 우선(offline-first)으로 Outbox에 기록 후 비동기 동기화합니다.

1. 전송 직전 원격 이벤트를 `GET`으로 조회
2. `updated` 타임스탬프 비교
3. 최신 버전 우선 자동 해결
4. 실패 시 지수 백오프로 재시도

Google 최신이면 로컬 변경을 폐기하고, 로컬 최신이면 원격에 반영합니다.

## Testing Guidelines
테스트는 UI 동작보다 동기화 정확도를 우선합니다. Vitest를 사용합니다.

- Outbox enqueue/dequeue, 재시도, 중복 방지
- 반복 일정 RRULE 변환 정확도
- eventType Push/Pull 라운드트립
- 참석자 초대/업데이트 전파
- 네트워크 실패 및 복구 시나리오

Google API 호출은 모킹하고, 테스트 파일은 `*.test.ts` 패턴을 사용합니다.
Vitest 설정은 `app/vitest.config.ts`에 있습니다.

## Commit & Pull Request Guidelines
Conventional Commits를 사용합니다 (`feat:`, `fix:`, `refactor:`, `docs:`).
PR에는 문제 정의, 변경 요약, 테스트 명령/결과, 데이터 모델 변경 여부(Prisma), UI 변경 시 스크린샷을 포함합니다.
