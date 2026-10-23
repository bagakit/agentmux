import base from './capsule-settings.config.mts'
import { resolve } from 'node:path'
import { root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

export default { ...base, resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/capsule\/runtime$/u, replacement: resolve(root, 'packages/capsule/src/runtime.ts') }, ...base.resolve.alias
] }, test: { ...base.test, include: ['apps/desktop/test/capsule-main.test.ts'], testTimeout: 20000 } }
