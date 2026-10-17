import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// These source-owned HTTP/IPC tests do not load Core dist or start the application.
export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: { include: ['apps/desktop/test/html-preview-cancellation.test.ts', 'apps/desktop/test/html-preview-ipc.test.ts'] }
})
