import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..')

if (!process.env.APP_ROOT) {
  process.env.APP_ROOT = appRoot
}

// Keep database location stable regardless of current working directory.
// In packaged builds the asar is read-only, so place the database
// in the writable userData directory instead.
if (!process.env.DATABASE_URL) {
  if (app.isPackaged) {
    process.env.DATABASE_URL = path.join(app.getPath('userData'), 'calendar.db')
  } else {
    process.env.DATABASE_URL = path.join(appRoot, 'dev.db')
  }
}
