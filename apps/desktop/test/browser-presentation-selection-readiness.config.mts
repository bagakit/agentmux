import { defineConfig } from 'vitest/config'
import owning from './workbench-window-presentations.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/browser-presentation-selection.test.tsx'],
  testNamePattern: /cancels selection when the intent reverses|does not reclaim a later human input owner/
} })
