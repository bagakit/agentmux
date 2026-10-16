import { defineConfig } from 'vitest/config'
import shared from '../agent-input-recall/vitest.recall.config.mts'
export default defineConfig({ ...shared, cacheDir: '.tmp/focus-reading-density/reader-cache', test: { ...shared.test,
  include: ['apps/desktop/test/agent-reading-density.test.tsx', 'apps/desktop/test/agent-information-card.test.tsx',
    'apps/desktop/test/agent-reading-pin.test.tsx', 'apps/desktop/test/agent-reading-preview.test.tsx',
    'apps/desktop/test/agent-reading-images.test.tsx', 'apps/desktop/test/agent-input-recall.test.tsx',
    'apps/desktop/test/agent-bookmarks.integration.test.tsx', 'apps/desktop/test/agent-bookmark-interaction.test.tsx',
    'apps/desktop/test/current-activity-consumers.test.tsx',
    'apps/desktop/test/semantic-icon-authored-caller-bindings.test.tsx'],
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
