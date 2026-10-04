import { defineConfig, defaultExclude } from 'vitest/config'
import base from '../../../vitest.config'

// These gates also run in a repository-nested worktree. Name the actual production
// test files explicitly, so the worktree exclusion cannot hide this candidate.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['apps/desktop/test/note-file-surface.test.tsx', 'apps/desktop/test/renderer-crash-recovery.test.ts', 'apps/desktop/test/window-state-persistence.test.ts', 'apps/desktop/test/workbench-storage-authority.test.ts', 'apps/desktop/test/*quit*.test.ts', 'apps/desktop/test/owner-disposal.test.ts', 'apps/desktop/test/main-crash-capture.test.ts', 'apps/desktop/test/startup-diagnostics.test.ts', 'apps/desktop/test/startup-failure-exit.test.ts', 'apps/desktop/test/crash-log-diagnostics-control.test.ts'],
    exclude: defaultExclude
  }
})
