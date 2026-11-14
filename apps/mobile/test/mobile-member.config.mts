import { resolve } from 'node:path'
import base from '../vitest.config'
import source from '../../desktop/test/vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, root, resolve: source.resolve, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { ...base.test, setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')],
    include: ['apps/mobile/test/mobile-member-route.test.tsx', 'apps/mobile/test/mobile-member-native.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 60000 } }
