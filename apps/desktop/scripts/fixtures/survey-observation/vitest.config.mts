import { defineConfig } from 'vitest/config'
import owning from '../survey-page-cli/vitest.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['apps/desktop/test/survey-tab-composition.test.tsx', 'apps/desktop/test/desktop-map-presentation.test.ts'],
  testNamePattern: '\\[survey-observation\\]|validates the same strict Focus view discriminant' } })
