import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import source from '../settings-overview/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
export default defineConfig({ ...source, root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 test: { ...source.test, include: ['apps/desktop/test/composer-pending-edit.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
