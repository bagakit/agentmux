import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const changes = {
  paintOrder: ['.sort((left, right) => compareOverlayPaintOrder(left, right, nativeOrder, styleOf))', '.sort(() => 0)'],
  failedPair: ['if (region.modal && failedModals.has(region.modal.id)) continue', 'if (false) continue'],
  groupBudget: ['const key = region.modal?.id ?? region.id', 'const key = region.id'],
  completionPaintRoot: ['data-state="open" className="composer-completion-popover"', 'className="composer-completion-popover"']
} as const
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ ...original, plugins: [{ name: 'private-collector-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.OVERLAY_COLLECTOR_MUTATION as keyof typeof changes | undefined
  if (!name) return
  const owner = name === 'completionPaintRoot' ? 'packages/client-ui/src/components/ComposerCompletionEditor.tsx' : 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts'
  if (relative(root, id) !== owner) return
  assert.ok(changes[name])
  const [before, after] = changes[name]
  assert.equal(source.split(before).length - 1, 1, 'A mutation must hit one actual production owner')
  const changed = source.replace(before, after)
  if (process.env.OVERLAY_COLLECTOR_HITS) appendFileSync(process.env.OVERLAY_COLLECTOR_HITS,
    JSON.stringify({ name, file: owner, source: sha(source), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/native-overlay-modal.test.ts', 'apps/desktop/test/native-overlay-completion.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
