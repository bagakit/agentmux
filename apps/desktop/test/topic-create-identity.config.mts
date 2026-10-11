import { defineConfig } from 'vitest/config'
import owning from './git-workbench.config.mts'

// Exact creation/identity consumers; unrelated directory styling and search timing
// belong to their original suites and cannot certify this repair.
export default defineConfig({
  ...owning,
  test: { ...owning.test,
    testNamePattern: /creates a canonical Topic|keeps the original request without binding|binds the canonical identity|explicit original Topic creation/
  }
})
