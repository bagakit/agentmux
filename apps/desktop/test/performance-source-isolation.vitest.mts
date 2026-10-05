import { fileURLToPath } from 'node:url'
import base from '../../../vitest.config'

// Execute the actual Core source parser at the Main import boundary for mutations.
// The default entry and compiled CLI also exercise the normal built package.
export default { ...base, resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/core\/control$/u, replacement: fileURLToPath(new URL('../../../packages/core/src/control.ts', import.meta.url)) }
] } }
