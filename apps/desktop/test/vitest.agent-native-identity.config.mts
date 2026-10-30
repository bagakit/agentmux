import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, test: { ...source.test, include: ['apps/desktop/test/agent-native-identity.test.tsx'] } })
