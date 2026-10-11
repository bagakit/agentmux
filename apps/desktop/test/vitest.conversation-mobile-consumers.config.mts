import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-unified-mobile', resolve: { ...base.resolve, conditions: ['module', 'import', 'default'] },
 ssr: { ...base.ssr, resolve: { conditions: ['module', 'import', 'default'] } },
 test: { ...base.test, testTimeout: 20000, include: ['apps/mobile/test/conversation-protocol-consumer.test.tsx'] } })
