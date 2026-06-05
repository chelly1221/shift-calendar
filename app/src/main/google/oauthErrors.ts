/**
 * Pure OAuth / Google API error classification.
 *
 * Intentionally free of electron / googleapis / DB imports so it can be unit tested in isolation
 * and imported cheaply from anywhere (oauthClient, outboxWorker, …).
 */

/** Refresh token expired or revoked → the stored token is permanently dead; user must reconnect. */
const REAUTH_OAUTH_ERROR_CODES = new Set(['invalid_grant', 'invalid_token'])
/** OAuth client misconfiguration → permanent, but the stored refresh token may still be valid. */
const CONFIG_OAUTH_ERROR_CODES = new Set(['invalid_client', 'unauthorized_client'])

/**
 * Structured auth failure raised when an access-token refresh fails for a reason that will never
 * succeed on retry. Carries the OAuth error code and a `needsReauth` flag so callers can stop
 * retrying (circuit breaker) and the UI can distinguish "reconnect" from "fix client config".
 */
export class GoogleAuthError extends Error {
  readonly code: string
  readonly needsReauth: boolean

  constructor(message: string, options: { code: string; needsReauth: boolean; cause?: unknown }) {
    super(message)
    this.name = 'GoogleAuthError'
    this.code = options.code
    this.needsReauth = options.needsReauth
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * Extract the OAuth2 error code (e.g. 'invalid_grant') from a token-endpoint failure.
 * google-auth-library surfaces it at `error.response.data.error`; we also fall back to a
 * top-level `error` field and a message scan so a structure change doesn't silently drop it.
 */
export function extractOAuthErrorCode(error: unknown): string | null {
  if (error == null || typeof error !== 'object') return null
  const candidate = error as {
    response?: { data?: { error?: unknown } }
    error?: unknown
    message?: unknown
  }
  const fromResponse = candidate.response?.data?.error
  if (typeof fromResponse === 'string' && fromResponse.length > 0) {
    return fromResponse
  }
  const topLevel = candidate.error
  if (typeof topLevel === 'string' && topLevel.length > 0) {
    return topLevel
  }
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  for (const code of [...REAUTH_OAUTH_ERROR_CODES, ...CONFIG_OAUTH_ERROR_CODES]) {
    if (message.includes(code)) return code
  }
  return null
}

export function isReauthOAuthErrorCode(code: string | null): code is string {
  return code !== null && REAUTH_OAUTH_ERROR_CODES.has(code)
}

export function isPermanentOAuthErrorCode(code: string | null): code is string {
  return code !== null && (REAUTH_OAUTH_ERROR_CODES.has(code) || CONFIG_OAUTH_ERROR_CODES.has(code))
}

export type GoogleErrorKind = 'TRANSIENT' | 'PERMANENT' | 'RATE_LIMITED' | 'AUTH_REQUIRED'

/**
 * Classify an error from a Google sync operation so the outbox worker can decide whether to
 * retry (TRANSIENT), give up on this job (PERMANENT), back off (RATE_LIMITED), or pause the whole
 * worker until the account is reconnected (AUTH_REQUIRED).
 */
export function classifyGoogleError(error: unknown): GoogleErrorKind {
  // Account-level auth failure (invalid_grant etc.). Every queued job will fail identically, so
  // this must NOT be treated as a transient per-job error that retries for the full retry window.
  if (error instanceof GoogleAuthError) {
    return 'AUTH_REQUIRED'
  }
  const candidate = error as {
    code?: number
    status?: number
    response?: { status?: number }
    message?: string
  }
  const code = candidate.code ?? candidate.status ?? candidate.response?.status
  if (code === 429) return 'RATE_LIMITED'
  if (code === 401 || code === 403 || code === 404) return 'PERMANENT'
  if (code === 410 || code === 408 || code === 503 || code === 500) return 'TRANSIENT'
  // Defensive: an auth failure whose structured shape was lost (e.g. re-wrapped as a plain Error)
  // should still break the loop rather than retry forever.
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  if (message.includes('invalid_grant') || message.includes('재인증이 필요')) {
    return 'AUTH_REQUIRED'
  }
  return 'TRANSIENT'
}
