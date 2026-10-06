import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  root,
  cacheDir: resolve(root, '.local/cache/native-writer-retirement-vite'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: {
    include: [
      'packages/core/test/{current-terminal-prompt,current-terminal-input,input-authority-cancellation}.test.ts',
      'packages/core/test/{native-admission-history,native-input-durable-wait,native-process-birth}.test.ts',
      'packages/core/test/{native-record-alias,codex-native-record-role}.integration.test.ts',
      'packages/core/test/{public-immediate-message,public-send-run-fence,public-rpc-hosted-runtime,dispatch-reply-chain}.test.ts',
      'packages/core/test/{immediate-provider,immediate-prompt,codex-prompt-footer,codex-current-input-capability,session-status-authority}.test.ts'
    ],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000
  }
})
