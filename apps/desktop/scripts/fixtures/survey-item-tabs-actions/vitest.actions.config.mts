import owning from '../note-restore/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...owning, test: { ...owning.test, testNamePattern: '\\[survey-item-actions\\]' } })
