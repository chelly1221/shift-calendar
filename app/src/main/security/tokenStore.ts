import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SERVICE_NAME = 'shift-calendar'
const ACCOUNT_NAME = 'google-oauth'
const FALLBACK_STORE_PATH = path.join(os.homedir(), '.shift-calendar', 'token-store.json')

interface FallbackTokenStore {
  refreshToken?: string
}

let cachedKeytar: typeof import('keytar') | null | undefined = undefined

async function loadKeytar(): Promise<typeof import('keytar') | null> {
  if (cachedKeytar !== undefined) return cachedKeytar
  try {
    cachedKeytar = await import('keytar')
    return cachedKeytar
  } catch {
    // Don't cache failure - allow retry next time
    return null
  }
}

async function readFallbackTokenStore(): Promise<FallbackTokenStore> {
  try {
    const raw = await fs.readFile(FALLBACK_STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as FallbackTokenStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeFallbackTokenStore(payload: FallbackTokenStore): Promise<void> {
  await fs.mkdir(path.dirname(FALLBACK_STORE_PATH), { recursive: true, mode: 0o700 })
  await fs.writeFile(FALLBACK_STORE_PATH, JSON.stringify(payload), 'utf8')
  // chmod is a no-op on Windows; best-effort for NTFS ACL awareness
  await fs.chmod(FALLBACK_STORE_PATH, 0o600).catch(() => {})
}

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  const keytar = await loadKeytar()
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, refreshToken)
      return
    } catch {
      // Keytar save failed, fall through to file store
      // Also try to delete stale keytar entry to prevent inconsistency
      try { await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME) } catch { /* ignore */ }
    }
  }

  await writeFallbackTokenStore({ refreshToken })
}

export async function loadRefreshToken(): Promise<string | null> {
  const keytar = await loadKeytar()
  if (keytar) {
    try {
      const refreshToken = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
      if (refreshToken) {
        return refreshToken
      }
    } catch {
      // Fall through to file-based storage if keyring service is unavailable.
    }
  }

  const fallback = await readFallbackTokenStore()
  return typeof fallback.refreshToken === 'string' && fallback.refreshToken.length > 0
    ? fallback.refreshToken
    : null
}

export async function clearRefreshToken(): Promise<boolean> {
  let deleted = false
  const keytar = await loadKeytar()
  if (keytar) {
    try {
      deleted = await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME)
    } catch (err) {
      console.error('[TokenStore] Failed to delete from keytar:', err)
    }
  }
  try {
    await writeFallbackTokenStore({})
  } catch (err) {
    console.error('[TokenStore] Failed to clear fallback store:', err)
  }
  return deleted
}
