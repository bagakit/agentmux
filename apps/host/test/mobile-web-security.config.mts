import { defineConfig } from 'vitest/config'
import original from './mobile-web.config.mts'

export default defineConfig({ ...original, test: { ...original.test, include: ['apps/host/test/mobile-web-security.test.ts'] } })
