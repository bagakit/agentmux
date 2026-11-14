import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..'), evidence = process.env.NODE_EDIT_EVIDENCE
if (evidence) mkdirSync(evidence, { recursive: true })
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'original-node-edit-native-writer', enforce: 'pre' as const, transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!), original = source
    if (process.env.NODE_EDIT_DROP_PERSISTENCE === '1' && path === 'apps/desktop/src/renderer/src/store.ts') {
      const before = '    nodePublicationDrafts: state.nodePublicationDrafts,'
      if (source.split(before).length !== 2) throw Error('One actual Node editing projection required')
      source = source.replace(before, '')
    }
    if (process.env.NODE_EDIT_RETAIN_LIVE_PHASE === '1' && path === 'apps/desktop/src/renderer/src/lib/node-publication-draft.ts') {
      const before = "pending: { ...entry.pending, phase: 'unknown' }"
      if (source.split(before).length !== 2) throw Error('One actual departed-producer phase transition required')
      source = source.replace(before, "pending: { ...entry.pending, phase: 'in-flight' }")
    }
    // Match the existing native user-document consumer: API transport leaves are
    // controlled, but the production Store and document use their shipping writer.
    if (['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts'].includes(path)) source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    if (evidence && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/core/src/node-publishing'))) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(resolve(evidence, `${process.env.NODE_EDIT_PHASE ?? 'parent'}-loaded.jsonl`), JSON.stringify({ path, original: hash(original), loaded: hash(source), mutant: process.env.NODE_EDIT_DROP_PERSISTENCE === '1' && path.endsWith('/store.ts') || process.env.NODE_EDIT_RETAIN_LIVE_PHASE === '1' && path.endsWith('/node-publication-draft.ts') }) + '\n')
    }
    if (source !== original) return { code: source, map: null }
  }
}], cacheDir: resolve(root, '.local/state/network-node-monitoring/ui-edit-test-cache'), test: {
  ...base.test, include: ['apps/desktop/test/node-publication-persistence.test.tsx'], maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 30_000
} }
