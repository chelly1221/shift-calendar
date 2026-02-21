import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..')
const defaultDbPath = path.join(appRoot, 'dev.db')

if (!process.env.APP_ROOT) {
  process.env.APP_ROOT = appRoot
}

// Keep database location stable regardless of current working directory.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = defaultDbPath
}
