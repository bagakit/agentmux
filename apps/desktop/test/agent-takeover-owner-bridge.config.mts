import { defineConfig } from 'vitest/config'
import source from './agent-takeover-source.config.mts'

export default defineConfig({ ...source, test: { ...source.test, include: ['apps/desktop/test/agent-takeover-owner-bridge.test.ts'], passWithNoTests: false } })
