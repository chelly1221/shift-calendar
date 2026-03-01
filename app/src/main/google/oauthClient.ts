import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { clipboard, dialog, shell } from 'electron'
import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from '../security/tokenStore'
import { getGoogleOAuthConfig } from '../db/settingRepository'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

interface GoogleConfig {
  clientId: string
  clientSecret: string
}

async function loadGoogleConfig(): Promise<GoogleConfig | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
  if (clientId && clientSecret) {
    return { clientId, clientSecret }
  }

  const dbConfig = await getGoogleOAuthConfig()
  if (dbConfig.clientId && dbConfig.clientSecret) {
    return { clientId: dbConfig.clientId, clientSecret: dbConfig.clientSecret }
  }

  return null
}

export async function isGoogleOAuthConfigured(): Promise<boolean> {
  return Boolean(await loadGoogleConfig())
}

async function createOAuthClient(redirectUri: string): Promise<OAuth2Client> {
  const config = await loadGoogleConfig()
  if (!config) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
  }
  return new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri)
}

async function waitForAuthorizationCode(timeoutMs = 180_000): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = request.url ? new URL(request.url, 'http://127.0.0.1') : null
      const code = requestUrl?.searchParams.get('code')
      const error = requestUrl?.searchParams.get('error')

      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<h2>Google authorization failed.</h2><p>You can close this window.</p>')
        server.close()
        reject(new Error(`Google OAuth error: ${error}`))
        return
      }

      if (!code) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('No authorization code found.')
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h2>Google authorization complete.</h2><p>You can close this window.</p>')

      const address = server.address() as AddressInfo | null
      const redirectUri = address ? `http://127.0.0.1:${address.port}/oauth2callback` : ''
      server.close()
      resolve({ code, redirectUri })
    })

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address() as AddressInfo | null
      if (!address) {
        server.close()
        reject(new Error('Failed to start OAuth loopback server.'))
        return
      }

      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`
      try {
        const oauth = await createOAuthClient(redirectUri)
        const url = oauth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [CALENDAR_SCOPE],
        })
        console.info('[OAuth] Open this URL in browser:', url)

        let copied = false
        try {
          clipboard.writeText(url)
          copied = true
        } catch {
          copied = false
        }

        const opened = await shell.openExternal(url).then(
          () => true,
          () => false,
        )

        const launchDetail = [
          opened
            ? 'System browser launch requested.'
            : 'System browser did not open automatically. Open the URL manually.',
          copied
            ? 'The authorization URL has been copied to your clipboard.'
            : 'Could not copy the URL to clipboard.',
          '',
          url,
        ].join('\n')

        void dialog
          .showMessageBox({
            type: 'info',
            title: 'Google Sign-In',
            message: 'Continue Google authorization in your browser.',
            detail: launchDetail,
            buttons: ['OK'],
            defaultId: 0,
            cancelId: 0,
          })
          .catch(() => {
            // Do nothing. OAuth server keeps waiting for callback.
          })
      } catch (error) {
        server.close()
        reject(error instanceof Error ? error : new Error('Failed to launch browser for OAuth flow.'))
      }
    })

    setTimeout(() => {
      server.close()
      reject(new Error('Google OAuth timed out.'))
    }, timeoutMs).unref()
  })
}

export async function connectGoogleInteractive(): Promise<{ accountEmail: string | null }> {
  if (!(await isGoogleOAuthConfigured())) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
  }

  const { code, redirectUri } = await waitForAuthorizationCode()
  const oauth = await createOAuthClient(redirectUri)
  const tokenResponse = await oauth.getToken(code)

  const refreshToken = tokenResponse.tokens.refresh_token ?? (await loadRefreshToken())
  if (!refreshToken) {
    throw new Error('Google OAuth did not return a refresh token. Try reconnecting with prompt=consent.')
  }

  await saveRefreshToken(refreshToken)
  oauth.setCredentials({ ...tokenResponse.tokens, refresh_token: refreshToken })

  let accountEmail: string | null = null
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth })
    const me = await oauth2.userinfo.get()
    accountEmail = me.data.email ?? null
  } catch {
    accountEmail = null
  }

  return { accountEmail }
}

export async function getAuthorizedGoogleClient(): Promise<OAuth2Client> {
  if (!(await isGoogleOAuthConfigured())) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
  }

  const refreshToken = await loadRefreshToken()
  if (!refreshToken) {
    throw new Error('Google account is not connected.')
  }

  const oauth = await createOAuthClient('http://127.0.0.1')
  oauth.setCredentials({ refresh_token: refreshToken })
  try {
    await oauth.getAccessToken()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[OAuth] Failed to refresh access token:', message)
    throw new Error(`Google 인증 토큰 갱신 실패: ${message}`)
  }
  return oauth
}

export async function disconnectGoogleAccount(): Promise<void> {
  // Try to revoke token at Google before clearing locally
  try {
    const refreshToken = await loadRefreshToken()
    if (refreshToken) {
      const oauth = await createOAuthClient('http://127.0.0.1')
      oauth.setCredentials({ refresh_token: refreshToken })
      await oauth.revokeToken(refreshToken).catch(() => {
        // Revocation failure is non-fatal - token may already be invalid
        console.warn('[OAuth] Token revocation failed, proceeding with local cleanup')
      })
    }
  } catch {
    // Non-fatal: proceed with local cleanup even if revocation fails
    console.warn('[OAuth] Could not revoke token, proceeding with local cleanup')
  }
  await clearRefreshToken()
}

export async function isGoogleConnected(): Promise<boolean> {
  const refreshToken = await loadRefreshToken()
  return Boolean(refreshToken)
}
