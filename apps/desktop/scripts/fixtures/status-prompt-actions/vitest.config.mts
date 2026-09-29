import { defineConfig } from 'vitest/config'
import sourceConfig from '../settings-overview/vitest.config.mts'

// This Renderer slice consumes actual Core sources; it does not certify compiled Native assets.
export default defineConfig({
  ...sourceConfig,
  test: {
    ...sourceConfig.test,
    include: [
      'apps/desktop/test/status-prompt-settings.test.tsx',
      'apps/desktop/test/settings-prompts-library.test.tsx',
      'apps/desktop/test/settings-resources-draft.test.tsx',
      'apps/desktop/test/composer-shortcut-library.test.ts',
      'apps/desktop/test/agent-status-prompt-actions.test.tsx',
      'apps/desktop/test/agent-session-composer.test.tsx',
      'apps/desktop/test/agent-avatar-settings.test.tsx',
      'apps/desktop/test/session-result-review.test.tsx',
      'apps/desktop/test/composer-submit-mode.test.ts',
      'apps/desktop/test/composer-identity.test.tsx',
      'apps/desktop/test/composer-session-controls.test.tsx',
      'apps/desktop/test/session-result-review-routing.test.tsx',
      'apps/desktop/test/focus-result-outlet-activation.test.tsx'
    ]
  }
})
