import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient__: PrismaClient | undefined
}

function resolveSqlitePathFromDatabaseUrl(databaseUrl: string): string {
  if (databaseUrl === ':memory:') {
    return ':memory:'
  }
  if (databaseUrl.startsWith('file:')) {
    return databaseUrl.slice('file:'.length)
  }
  return databaseUrl
}

const databaseUrl = process.env.DATABASE_URL ?? 'file:./dev.db'
const adapter = new PrismaBetterSqlite3({
  url: resolveSqlitePathFromDatabaseUrl(databaseUrl),
})

export const prisma = globalThis.__prismaClient__ ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient__ = prisma
}
