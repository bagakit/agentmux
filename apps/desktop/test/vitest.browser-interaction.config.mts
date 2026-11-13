import { defineConfig } from 'vitest/config'
import currentSources from './vitest.mote-context.config.mts'

// Browser qualification consumes the current public workspace sources, not a peer's stale dist.
export default defineConfig({ ...currentSources, test: { ...currentSources.test,
  include: [
    'apps/desktop/test/browser-agent-handoff.test.tsx',
    'apps/desktop/test/browser-agent-creation-options.test.tsx',
    'apps/desktop/test/browser-view-manager.test.ts',
    'apps/desktop/test/browser-agent-authority.test.ts',
    'apps/desktop/test/browser-operation-request-identity.test.ts',
    'apps/desktop/test/browser-operation-feedback.test.ts',
    'apps/desktop/test/browser-page-action-feedback.test.ts',
    'apps/desktop/test/browser-contextual-queue.test.ts',
    'apps/desktop/test/browser-operation-state-density.test.tsx',
    'apps/desktop/test/browser-operation-surface.test.tsx',
    'apps/desktop/test/browser-agent-release-renderer.test.ts'
  ], passWithNoTests: false
} })
