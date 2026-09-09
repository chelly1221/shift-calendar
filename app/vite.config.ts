import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
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

/**
 * MediaPipe Tasks Vision의 WASM 런타임을 public/mediapipe/wasm 으로 복사합니다.
 * FilesetResolver.forVisionTasks(basePath)가 고정 파일명(vision_wasm_internal.js 등)을 기대하므로
 * Vite 해시 번들링 대신 public 자산으로 그대로 서빙합니다 (dev: /mediapipe/wasm, build: dist/mediapipe/wasm).
 * 복사본은 .gitignore 대상이며 모델 파일(hand_landmarker.task)만 저장소에 포함합니다.
 */
function syncMediapipeWasm(): void {
  const source = path.join(__dirname, 'node_modules/@mediapipe/tasks-vision/wasm')
  const target = path.join(__dirname, 'public/mediapipe/wasm')
  if (!fs.existsSync(source)) {
    console.warn('[mediapipe] wasm 디렉터리를 찾을 수 없습니다. npm i 를 먼저 실행하세요.')
    return
  }
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name)
    const to = path.join(target, name)
    const fromStat = fs.statSync(from)
    if (!fromStat.isFile()) continue
    // ES 모듈 변형(vision_wasm_module_*)은 forVisionTasks(basePath, useModule=false) 경로에서 쓰지 않으므로 제외
    if (name.includes('_module_')) continue
    const toStat = fs.existsSync(to) ? fs.statSync(to) : null
    if (toStat && toStat.size === fromStat.size && toStat.mtimeMs >= fromStat.mtimeMs) continue
    fs.copyFileSync(from, to)
  }
}

syncMediapipeWasm()

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
        entry: { main: 'src/main/main.ts', neuralSpeechWorker: 'src/main/voice/neuralSpeechWorker.ts' },
        vite: {
          define: command === 'serve'
            ? { 'process.env.VITE_DEV_SERVER_URL': JSON.stringify('http://localhost:5173') }
            : undefined,
          plugins: [
            cjsInteropPlugin(['@prisma/client']),
          ],
          build: {
            // Remove old hashed main bundles before packaging; preload is built afterwards.
            emptyOutDir: true,
            rollupOptions: {
              output: { entryFileNames: '[name].js' },
              external: [
                'keytar',
                '@prisma/client',
                '.prisma/client/default',
                '@prisma/client/default',
                '@prisma/client/runtime/library',
                '@prisma/adapter-better-sqlite3',
                '@prisma/driver-adapter-utils',
                'better-sqlite3',
                'onnxruntime-node',
                'mpg123-decoder',
                'ws',
              ],
            },
          },
        },
      },
      preload: {
        input: {
          preload: path.join(__dirname, 'src/preload/index.ts'),
        },
        vite: { build: { emptyOutDir: false } },
      },
      renderer: process.env.NODE_ENV === 'test'
        ? undefined
        : {},
    }),
  ],
}))
