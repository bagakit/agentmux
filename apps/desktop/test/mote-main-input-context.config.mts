import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mote-discussion-threads.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const variants = {
 'background-reader': ['apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'contextKey={moteContextKey}', 'contextKey={undefined}'],
 'background-actions': ['apps/desktop/src/renderer/src/lib/mote-presentation-context.tsx', 'own ? value?.workface ?? null : parentWorkface', 'parentWorkface'],
} as const
const mutation = process.env.AGENTMUX_MOTE_CONTEXT_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Mote presentation mutation')
export default defineConfig({ ...base,
 plugins: [...base.plugins ?? [], { name: 'loaded-mote-presentation-counterexample', enforce: 'pre', transform(original, id) {
  if (!mutation) return
  const [file, before, after] = variants[mutation]
  if (relative(root, id.split('?')[0]!) !== file) return
  if (original.split(before).length !== 2) throw Error('Expected exactly one original production mutation anchor')
  const changed = original.replace(before, after), trace = process.env.AGENTMUX_MOTE_CONTEXT_TRACE
  if (!trace) throw Error('Loaded source trace is required')
  const sha = (source: string) => createHash('sha256').update(source).digest('hex')
  appendFileSync(trace, JSON.stringify({ mutation, file, original: sha(original), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
 } }],
 test: { ...base.test, maxWorkers: 1, fileParallelism: false, include: ['apps/desktop/test/mote-main-input-context.test.tsx', 'apps/desktop/test/mote-discussion-threads.test.tsx', 'apps/desktop/test/mote-threads-source.test.tsx'] }
})
