import composition from './vitest.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...composition, test: { ...composition.test,
  include: ['apps/desktop/test/survey-list-ui.test.tsx', 'apps/desktop/test/browser-workface-boundary.test.tsx', 'apps/desktop/test/survey-composition-mote-context.test.tsx'] } })
