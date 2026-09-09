import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

export function assertBackupDestination(destination: string, databasePath: string): void {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const target = normalize(destination)
  if (['', '-wal', '-shm', '.import'].some((suffix) => target === normalize(databasePath + suffix))) {
    throw new Error('사용 중인 데이터베이스와 다른 경로에 백업을 저장해 주세요.')
  }
}

export function validateDatabaseBackup(database: Database.Database): void {
  if (database.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new Error('손상된 데이터베이스는 가져올 수 없습니다.')
  }
  // Unquoted column identifiers make SQLite reject backups with missing fields.
  database.prepare('SELECT localId, summary, startAtUtc, endAtUtc, timeZone, syncState FROM Event LIMIT 0').all()
  database.prepare('SELECT id, syncToken FROM Setting LIMIT 0').all()
  database.prepare('SELECT id, operation, payloadJson, status FROM OutboxJob LIMIT 0').all()
}

export function stageDatabaseImport(sourcePath: string, stagingPath: string): void {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  const temporaryPath = `${stagingPath}.${randomUUID()}.tmp`
  try {
    validateDatabaseBackup(source)
    // VACUUM includes committed WAL contents; copying the .db file alone can lose them.
    source.exec(`VACUUM INTO '${temporaryPath.replace(/'/g, "''")}'`)
    renameSync(temporaryPath, stagingPath)
  } finally {
    source.close()
    rmSync(temporaryPath, { force: true })
  }
}
