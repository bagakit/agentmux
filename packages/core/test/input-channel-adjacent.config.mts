import { defineConfig } from 'vitest/config'
import rawInput from './raw-input-authority.config.mts'

export default defineConfig({ ...rawInput, test: { ...rawInput.test, include: [
  'packages/core/test/agent-semantic-state-entry.test.ts',
  'packages/core/test/current-terminal-prompt.test.ts',
  'packages/core/test/stop-explicit-retry.test.ts',
  'packages/core/test/immediate-prompt.test.ts',
  'packages/core/test/prompt-submission-diagnostics.test.ts',
  'packages/core/test/input-lane-evidence.test.ts',
  'packages/core/test/client-input-cancellation-cause.test.ts'
] } })
