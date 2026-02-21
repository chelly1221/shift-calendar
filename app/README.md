# Local Google Calendar Electron App (MVP v1)

Electron + React + Prisma(SQLite) 기반의 로컬 우선 Google Calendar 데스크톱 앱입니다.

## 핵심 원칙

- `renderer`는 UI/상태 표시만 담당
- 네트워크/OAuth/DB/동기화는 `main`에서 처리
- 로컬 DB를 즉시 반영하고 Outbox로 비동기 동기화
- 충돌은 `googleUpdatedAtUtc` vs `localEditedAtUtc` 최신 기준 자동 해결

## 폴더 구조

- `src/main/ipc`: IPC 채널/핸들러
- `src/main/db`: Prisma 저장소
- `src/main/google`: OAuth + Google Calendar API
- `src/main/sync`: Outbox 워커, Full/Delta 동기화
- `src/main/security`: keytar 토큰 저장
- `src/preload`: 안전한 브리지 API
- `src/renderer`: React UI

## 실행

```bash
npm i
npm run dev
```

## 품질 검사

```bash
npm run lint
npm run type-check
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

## 현재 지원 범위

- 로컬 이벤트 조회/생성/수정/삭제
- 참석자 이메일, `sendUpdates` 플래그 저장/전송
- Outbox 큐(패치 coalesce, 백오프 재시도)
- Full/Delta 동기화 + `410` 시 Full 재동기화
- Google OAuth 루프백(127.0.0.1) 연결/해제

## MVP에서 제외

- 드래그 이동 / 리사이즈
- 사용자 수동 충돌 선택 UI
