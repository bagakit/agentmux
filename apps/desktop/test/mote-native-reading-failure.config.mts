import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_MOTE_NATIVE_FAILURE_MUTATION
if (mutation && mutation !== 'drop-empty-mote-wrapper') throw Error('Unknown Native failure mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], { name: 'loaded-native-reading-failure-counterexample', enforce: 'pre', transform(original, id) {
  if (!mutation || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/renderer/src/components/ActivityView.tsx') return
  const before = '!moteConversation && unlocated ? renderCurrent([])', after = 'unlocated ? renderCurrent([])'
  if (original.split(before).length !== 2) throw Error('The actual empty-reader Mote composition anchor must be unique')
  const changed = original.replace(before, after), trace = process.env.AGENTMUX_MOTE_NATIVE_FAILURE_TRACE
  if (!trace) throw Error('Production loading receipt is required')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  appendFileSync(trace, JSON.stringify({ mutation, file: relative(root, id.split('?')[0]!), before: sha(original), after: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], resolve: { ...base.resolve, alias: [...(base.resolve!.alias as []), ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] }, test: { ...base.test,
  include: ['apps/desktop/test/mote-native-reading-failure.test.tsx'], passWithNoTests: false, testTimeout: 20000 } })
