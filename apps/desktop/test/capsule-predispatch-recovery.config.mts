import { resolve } from 'node:path'
import base from './capsule-settings.config.mts'

export default { ...base, resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/capsule\/runtime$/u, replacement: resolve(base.root!, 'packages/capsule/src/runtime.ts') },
  ...base.resolve.alias,
] }, test: { ...base.test, include: ['apps/desktop/test/capsule-predispatch-recovery.test.tsx'] } }
