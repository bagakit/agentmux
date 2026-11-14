import { resolve } from 'node:path'
import base from './mobile-member.config.mts'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, test: { ...base.test, include: [resolve(root, 'apps/mobile/test/mobile-zone-source.test.tsx')], passWithNoTests: false } }
