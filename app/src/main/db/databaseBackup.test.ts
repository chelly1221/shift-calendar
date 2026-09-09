import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertBackupDestination, stageDatabaseImport } from './databaseBackup'

const mocks = vi.hoisted(() => ({ pragma: vi.fn(), prepare: vi.fn(), exec: vi.fn(), close: vi.fn(), rename: vi.fn(), rm: vi.fn() }))
vi.mock('better-sqlite3', () => ({ default: class { pragma = mocks.pragma; prepare = mocks.prepare; exec = mocks.exec; close = mocks.close } }))
vi.mock('node:fs', () => ({ renameSync: mocks.rename, rmSync: mocks.rm }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.pragma.mockReturnValue('ok')
  mocks.prepare.mockReturnValue({ all: () => [] })
})

describe('database backup protection', () => {
  it.each(['', '-wal', '-shm', '.import'])('rejects an export over the active database %s file', (suffix) => {
    expect(() => assertBackupDestination(`calendar.db${suffix}`, 'calendar.db')).toThrow('다른 경로')
  })

  it('leaves the existing staged import intact when validation fails', () => {
    mocks.pragma.mockReturnValueOnce('database corruption')
    expect(() => stageDatabaseImport('backup.db', 'calendar.db.import')).toThrow('손상된')
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.rename).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('rejects unrelated SQLite databases before staging', () => {
    mocks.prepare.mockImplementationOnce(() => { throw new Error('no such table: Event') })
    expect(() => stageDatabaseImport('unrelated.db', 'calendar.db.import')).toThrow('no such table')
    expect(mocks.rename).not.toHaveBeenCalled()
  })

  it('does not replace the staged backup if creating its snapshot fails', () => {
    mocks.exec.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => stageDatabaseImport('backup.db', 'calendar.db.import')).toThrow('disk full')
    expect(mocks.rename).not.toHaveBeenCalled()
  })

  it('stages a consistent SQLite snapshot before replacing the import file', () => {
    stageDatabaseImport('backup.db', 'calendar.db.import')
    expect(mocks.exec.mock.calls[0][0]).toMatch(/^VACUUM INTO '/)
    expect(mocks.rename).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), 'calendar.db.import')
  })
})
