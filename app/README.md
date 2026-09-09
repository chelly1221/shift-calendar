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

## Windows EXE 빌드

```bash
npm run build
```

빌드 전에 실행 중인 `교대근무 일정관리.exe`를 자동 종료합니다. 정상 종료를 먼저 요청하고,
10초 뒤에도 남아 있는 해당 앱의 프로세스만 강제 종료합니다. 종료에 실패하면 빌드를 중단합니다.
현재 사용하는 `release/0.0.0/win-unpacked/교대근무 일정관리.exe`와 같은 폴더의 실행 파일을 직접 갱신합니다.
버전이 바뀌어도 출력 폴더는 유지하며, 다른 위치의 배포본이나 별도 설치형·Portable EXE를 생성하지 않습니다.
갱신 후 이 경로의 프로그램을 다시 실행합니다. 사용자 데이터는 별도의 앱 데이터 폴더에 유지됩니다.

개발 실행과 빌드의 사전 단계에서 `npm run voice:prepare`가 Supertonic 3 음성 모델 약 398 MB를 준비합니다. [모델 manifest](voice-model-manifest.json)의 고정 Hugging Face revision과 SHA-256으로 파일을 검증하며, 유효한 파일은 다시 받지 않습니다. 새 파일은 임시 경로에 받은 뒤 검증을 통과해야 교체합니다. 모델은 `voice-model/`에 준비하고 배포본의 `resources/voice-model/`에 포함하므로 설치된 앱에서 음성을 합성할 때 모델 다운로드나 외부 TTS API 연결이 필요하지 않습니다. 원본 모델 라이선스와 [음성 구성요소 이용 조건](THIRD_PARTY_VOICE.md)을 함께 포함합니다.

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

## Google Cloud 설정 (중요)

Google 동기화를 위해 [Google Cloud Console](https://console.cloud.google.com/)에서 OAuth 클라이언트(데스크톱 앱)를 발급받아 Client ID/Secret을 설정합니다.

> ⚠️ **OAuth 동의화면 게시 상태 = '토큰갱신불가' 반복의 주요 원인**
>
> OAuth 동의화면(consent screen)이 **'테스트(Testing)' 상태**이면, 발급된 refresh token이 **7일 후 자동 만료**됩니다. 이 경우 7일마다 `invalid_grant`(인증 토큰 갱신 실패)가 반복되며 동기화가 중단됩니다.
>
> **해결:** OAuth 동의화면을 **'프로덕션(Production)'으로 게시**하거나(권장), 최소한 사용 중인 Google 계정을 동의화면의 **'테스트 사용자(Test users)'에 등록**합니다. 게시 상태에서는 refresh token이 무기한 유효합니다.
>
> 토큰이 이미 만료/취소된 경우, 앱의 **동기화 → Google 계정 → 다시 연결**로 즉시 복구할 수 있습니다. 토큰이 죽으면 앱이 무한 재시도를 멈추고 재연결 안내 배너를 표시합니다.

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
- 동기화 전용 2열 모달: 좌측(준비 상태/동기화 상태/계정/달력), 우측(작업별 상태)
- 작업별 상태 카드는 모달 여유 높이를 자동으로 채우고 목록만 내부 스크롤
- 작업별 상태에서 `QUEUED`/`FAILED` 작업을 즉시 삭제(취소) 가능

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

## Android 음성 연동

같은 Wi-Fi의 Android 앱이 PC를 자동으로 찾아 연결합니다. 비밀키 입력 없이 근무·휴가·교육·일정·반복업무를 질문하고, PC 월 이동과 일정 등록·변경·삭제를 할 수 있습니다. 변경은 휴대폰 미리보기 확인 후 실행합니다. Android 0.2.12(versionCode 14)는 답변을 휴대폰 화면에 표시하고 **PC의 Windows 기본 스피커**로 읽습니다. PC는 Supertonic 3 한국어 F1 AI 합성 음성을 사용합니다. Windows SAPI·Microsoft Heami와 Android 로컬 TTS는 사용하지 않습니다. 이번 음성 교체는 PC 갱신만 필요하며 기존 Android 0.2.11 APK와 호환됩니다.

슬래시 등 목록 구분 기호는 화면 표기를 유지하고 음성에서는 짧게 쉽니다. 합성은 PC CPU에서 5단계로 처리하며 최대 120자 구간으로 나누어 현재 구간을 읽는 동안 다음 한 구간을 준비합니다. 질문·이름·답변을 외부 음성 서버에 전송하지 않습니다. 해당 PC의 공개 안내 문장 두 개에서는 모델 초기화 약 1.05초, 약 4~5초 음성 생성 약 0.69~0.72초, 프로세스 메모리 약 516 MB를 측정했습니다. 이 수치는 해당 PC의 짧은 샘플 결과이며 모든 기기나 긴 답변의 지연을 보장하지 않습니다.

[근무물어봐-0.2.12.apk](release/0.0.0/win-unpacked/근무물어봐-0.2.12.apk)는 기기의 `smallestScreenWidthDp`와 현재 창 폭이 모두 600dp 이상일 때 태블릿용 두 영역으로 배치합니다. 스마트폰은 가로 회전해도 세로 배치를 유지하며 태블릿도 좁은 분할 창에서는 휴대폰 배치를 사용합니다. 회전·분할 화면 변경에 맞춰 다시 배치하고 큰 글자 설정에서는 버튼을 세로로 표시합니다. ‘까치야, 내일 야간 누구야?’처럼 이어서 말할 수 있으며 PC에는 변환된 텍스트만 보냅니다. 화면이 꺼져도 실행 중인 마이크 서비스가 대기하며, 입력이 끊기면 자동 복구를 시도합니다. 첫 실행에서 권한을 허용하고 음성 준비를 기다려 주세요. 기기 재부팅·강제 종료 후에는 앱을 다시 열어야 합니다.

Android 0.2.12는 음악·영상·게임 재생 중 상시 듣기와 호출어 인식을 잠시 쉬고, 재생이 끝나면 자동으로 다시 듣습니다. 상시 듣기 설정은 켜진 채 유지하고 화면·알림에 미디어 재생 중임을 표시합니다. 이 기능은 Android 업데이트가 필요하며, PC 답변과 직접 입력은 계속 사용할 수 있습니다.

새 모양 아이콘의 ‘까치야 상시 듣기’ 빠른 설정 타일을 제공합니다. Android 13 이상은 앱 설정의 ‘빠른 설정에 상시 듣기 추가’를 사용하고, 이전 버전은 빠른 설정 편집에서 추가합니다. 켤 때는 앱을 열어 마이크 권한을 확인한 뒤 서비스를 시작하고, 끄면 즉시 종료합니다. 타일은 실제 대기 상태를 표시합니다.

PC 응답의 `playback`은 재생 ID·상태·전체 텍스트·현재 구간·오류를 제공합니다. Android는 `GET /v1/speech`로 완료를 확인하고 `POST /v1/speech`로 다시 읽기와 중지를 요청합니다. 구버전 앱의 중복 음성을 막기 위해 기존 `speech` 필드는 비웁니다. PC는 긴 목록을 모두 순서대로 읽고 준비·개별 구간의 시간 초과를 처리합니다.

조회에서 `김수원 과장`은 같은 성의 한글 세 글자, 이름 한 음절 차이와 그 음절의 초·중·종성 차이 두 자리 이하 조건으로 등록된 `김수헌`에 연결할 수 있습니다. 정확한 이름을 우선하고 후보가 여러 명이면 되물으며 이름만 답해 선택할 수 있습니다. 일정 등록·변경·삭제에는 이 보정을 적용하지 않습니다. `A조 근무자 누구야?`처럼 조만 물으면 휴가 여부와 관계없이 설정 명단을 답하고, 날짜나 주간·야간을 명시하면 실제 근무와 부재를 반영합니다.

PC 앱 실행 시 연결 서버가 켜지며 설정에서 끌 수 있습니다. 같은 네트워크 기기는 인증 없이 접근합니다. [설치·빌드](../android/README.md), [지원 명령과 연결 조건](../docs/voice-assistant-design.md)을 참고하세요.

연결된 Android 실기기가 없어 타일·회전·분할 화면과 PC 응답 중 실제 음성인식은 실기기 확인이 남아 있습니다.
