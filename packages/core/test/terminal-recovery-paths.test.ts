import { expect, it, vi } from 'vitest'
import { parseTerminalRecoveryInput } from '../src/terminal-recovery.js'

const input = { expectedRun: { runId: 'original-run' }, runtimeId: 'original-runtime', operationId: 'original-operation' }

it('preserves opaque Host path structure without Node globals', () => {
  vi.stubGlobal('process', undefined)
  try {
    for (const workspacePath of ['/workspace', 'C:\\workspace', '\\server\\share', 'relative/path', '../other', 'C:relative']) {
      expect(parseTerminalRecoveryInput({ ...input, workspacePath }).workspacePath).toBe(workspacePath)
    }
  } finally {
    vi.unstubAllGlobals()
  }
})
