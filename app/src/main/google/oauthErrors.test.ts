import { describe, it, expect } from 'vitest'
import {
  GoogleAuthError,
  classifyGoogleError,
  extractOAuthErrorCode,
  isPermanentOAuthErrorCode,
  isReauthOAuthErrorCode,
} from './oauthErrors'

describe('GoogleAuthError', () => {
  it('code/needsReauth/cause를 보존한다', () => {
    const cause = new Error('original')
    const err = new GoogleAuthError('재인증 필요', { code: 'invalid_grant', needsReauth: true, cause })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('GoogleAuthError')
    expect(err.code).toBe('invalid_grant')
    expect(err.needsReauth).toBe(true)
    expect((err as { cause?: unknown }).cause).toBe(cause)
  })
})

describe('extractOAuthErrorCode', () => {
  it('gaxios error.response.data.error에서 코드를 추출한다', () => {
    const error = { response: { data: { error: 'invalid_grant' } } }
    expect(extractOAuthErrorCode(error)).toBe('invalid_grant')
  })

  it('top-level error 필드에서 코드를 추출한다', () => {
    expect(extractOAuthErrorCode({ error: 'invalid_client' })).toBe('invalid_client')
  })

  it('구조가 없으면 message 문자열을 스캔한다', () => {
    const error = new Error('Token has been expired or revoked: invalid_grant')
    expect(extractOAuthErrorCode(error)).toBe('invalid_grant')
  })

  it('알 수 없는 에러는 null을 반환한다', () => {
    expect(extractOAuthErrorCode(new Error('socket hang up'))).toBeNull()
    expect(extractOAuthErrorCode(null)).toBeNull()
    expect(extractOAuthErrorCode('string error')).toBeNull()
  })
})

describe('isReauthOAuthErrorCode / isPermanentOAuthErrorCode', () => {
  it('invalid_grant/invalid_token은 재인증이 필요하다', () => {
    expect(isReauthOAuthErrorCode('invalid_grant')).toBe(true)
    expect(isReauthOAuthErrorCode('invalid_token')).toBe(true)
  })

  it('invalid_client/unauthorized_client는 재인증 대상은 아니지만 영구 실패다', () => {
    expect(isReauthOAuthErrorCode('invalid_client')).toBe(false)
    expect(isPermanentOAuthErrorCode('invalid_client')).toBe(true)
    expect(isPermanentOAuthErrorCode('unauthorized_client')).toBe(true)
  })

  it('재인증 코드도 영구 실패에 포함된다', () => {
    expect(isPermanentOAuthErrorCode('invalid_grant')).toBe(true)
  })

  it('null/알 수 없는 코드는 false다', () => {
    expect(isReauthOAuthErrorCode(null)).toBe(false)
    expect(isPermanentOAuthErrorCode(null)).toBe(false)
    expect(isPermanentOAuthErrorCode('unknown')).toBe(false)
  })
})

describe('classifyGoogleError', () => {
  it('GoogleAuthError는 AUTH_REQUIRED로 분류한다', () => {
    const err = new GoogleAuthError('재인증', { code: 'invalid_grant', needsReauth: true })
    expect(classifyGoogleError(err)).toBe('AUTH_REQUIRED')
  })

  it('429는 RATE_LIMITED', () => {
    expect(classifyGoogleError({ code: 429 })).toBe('RATE_LIMITED')
    expect(classifyGoogleError({ response: { status: 429 } })).toBe('RATE_LIMITED')
  })

  it('401/403/404는 PERMANENT', () => {
    expect(classifyGoogleError({ code: 401 })).toBe('PERMANENT')
    expect(classifyGoogleError({ status: 403 })).toBe('PERMANENT')
    expect(classifyGoogleError({ response: { status: 404 } })).toBe('PERMANENT')
  })

  it('410/408/503/500은 TRANSIENT', () => {
    expect(classifyGoogleError({ code: 410 })).toBe('TRANSIENT')
    expect(classifyGoogleError({ code: 408 })).toBe('TRANSIENT')
    expect(classifyGoogleError({ code: 503 })).toBe('TRANSIENT')
    expect(classifyGoogleError({ code: 500 })).toBe('TRANSIENT')
  })

  it('회귀 방지: 구조를 잃은 invalid_grant 평문 Error도 AUTH_REQUIRED로 분류한다', () => {
    // 토큰 갱신 실패가 평문 Error로 재포장되어 code/status가 없는 과거 버그 상황
    const wrapped = new Error('Google 인증 토큰 갱신 실패: invalid_grant')
    expect(classifyGoogleError(wrapped)).toBe('AUTH_REQUIRED')
  })

  it('한국어 재인증 안내 메시지도 AUTH_REQUIRED로 분류한다', () => {
    const err = new Error('Google 재인증이 필요합니다 (invalid_grant). 다시 연결하세요.')
    expect(classifyGoogleError(err)).toBe('AUTH_REQUIRED')
  })

  it('코드/신호가 없는 일시 오류는 TRANSIENT (기본값)', () => {
    expect(classifyGoogleError(new Error('socket hang up'))).toBe('TRANSIENT')
    expect(classifyGoogleError({})).toBe('TRANSIENT')
  })
})
