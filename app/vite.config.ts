import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

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
