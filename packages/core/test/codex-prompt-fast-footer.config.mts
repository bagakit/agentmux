import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// These tests import the owning Provider source directly. The fixed input list
// prevents nested worktrees or frozen evidence from joining the test collection.
export default defineConfig({
  test: {
    root: resolve(import.meta.dirname, '../../..'),
    include: ['codex-prompt-fast-footer', 'codex-prompt-footer', 'codex-prompt-preparation-wait']
      .map(name => resolve(import.meta.dirname, `${name}.test.ts`)),
    environment: 'node', maxWorkers: 1, passWithNoTests: false
  }
})
