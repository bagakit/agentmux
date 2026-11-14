import { defineConfig } from 'vitest/config'
import source from './agent-takeover-source.config.mts'

export default defineConfig({ ...source, define: { ...source.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  test: { ...source.test, include: ['apps/desktop/test/agent-takeover-source-owner.test.tsx'], passWithNoTests: false, testTimeout: 30000, hookTimeout: 30000 } })
