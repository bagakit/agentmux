import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert.ok(['focus', 'shared'].includes(slice), 'Select one declared visual motion slice')
const selected = slice === 'focus'
  ? (await import('./affectui-focus-motion-mutations.mjs')).focusMotionMutations
  : (await import('./affectui-shared-motion-mutations.mjs')).sharedMotionMutations
await verifyRendererSourceMutations({ name: `affectui-${slice}-motion`, ...selected,
  evidenceRoot: process.env.AGENTMUX_AFFECTUI_MOTION_EVIDENCE ? resolve(process.env.AGENTMUX_AFFECTUI_MOTION_EVIDENCE) : undefined })
