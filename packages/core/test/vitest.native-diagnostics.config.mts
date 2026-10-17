import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { nativeDiagnosticSource } from './helpers/native-diagnostic-source.js'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root,
  cacheDir: resolve(root, '.tmp/recovery-late-exit-convergence/diagnostic-cache', process.env.AGENTMUX_DIAGNOSTIC_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-native-diagnostic-source', enforce: 'pre',
    transform(code, id) { const next = nativeDiagnosticSource(code, id); if (next !== code) return { code: next, map: null } }
  }],
  test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/codex-managed-diagnostic-stream.test.ts', 'packages/core/test/codex-native-diagnostics.test.ts',
      'packages/core/test/codex-managed-run-diagnostics.test.ts', 'packages/core/test/native-diagnostics-runtime.integration.test.ts'], testTimeout: 30_000 }
})
