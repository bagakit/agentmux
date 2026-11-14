import composition from '../survey-tab-composition/vitest.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...composition, test: { ...composition.test, include: ['apps/desktop/test/survey-tab-composition.test.tsx'] } })
