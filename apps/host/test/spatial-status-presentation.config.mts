import { resolve } from 'node:path'
import base from '../../mobile/test/mobile-member.config.mts'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, test: { ...base.test, include: [resolve(root, 'apps/host/test/spatial-status-presentation.test.tsx')], testTimeout: 60000, passWithNoTests: false } }
