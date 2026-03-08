import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

/**
 * Rollup plugin: transform named ESM imports from CJS-only packages
 * into default import + destructure.
 *
 * Node.js ESM cannot statically detect named exports from @prisma/client
 * because its CJS entry uses `module.exports = { ...require('#main-entry-point') }`.
 * The spread-require pattern is opaque to cjs-module-lexer, causing
 * `import { SyncState } from '@prisma/client'` to fail at runtime.
 *
 * This plugin rewrites the bundled output so that:
 *   import { Foo as F, Bar as B } from "@prisma/client";
 * becomes:
 *   import __prisma_client__ from "@prisma/client";
 *   const { Foo: F, Bar: B } = __prisma_client__;
 */
function cjsInteropPlugin(packages: string[]): Plugin {
  return {
    name: 'cjs-named-export-interop',
    renderChunk(code) {
      let result = code
      for (const pkg of packages) {
        const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(
          `import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escaped}["']\\s*;?`,
          'g',
        )
        if (!re.test(result)) continue
        re.lastIndex = 0
        const varName = '__' + pkg.replace(/[^a-zA-Z0-9]/g, '_') + '__'
        result = result.replace(re, (_, names: string) => {
          const destructured = names.replace(/\s+as\s+/g, ': ')
          return `import ${varName} from "${pkg}";\nconst {${destructured}} = ${varName};`
        })
      }
      return result === code ? null : result
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  server: {
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'src/main/main.ts',
        vite: {
          define: command === 'serve'
            ? { 'process.env.VITE_DEV_SERVER_URL': JSON.stringify('http://localhost:5173') }
            : undefined,
          plugins: [
            cjsInteropPlugin([
              '@prisma/client',
              '@prisma/adapter-better-sqlite3',
            ]),
          ],
          build: {
            rollupOptions: {
              external: [
                'keytar',
                '@prisma/client',
                '.prisma/client/default',
                '@prisma/client/default',
                '@prisma/client/runtime/library',
                '@prisma/adapter-better-sqlite3',
                '@prisma/driver-adapter-utils',
                'better-sqlite3',
              ],
            },
          },
        },
      },
      preload: {
        input: {
          preload: path.join(__dirname, 'src/preload/index.ts'),
        },
      },
      renderer: process.env.NODE_ENV === 'test'
        ? undefined
        : {},
    }),
  ],
}))
