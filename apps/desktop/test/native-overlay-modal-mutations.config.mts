import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/main/native-overlay-surfaces.ts'
const changes = {
  partialCommit: ['this.paint(projection, Boolean(modalId))', 'this.paint(projection)'],
  partialFailure: ['if (modalId) fail(modalId, message)', 'if (modalId) this.remove(prepared.at(-1)!.region.id, prepared.at(-1)!)'],
  backgroundInput: ['if (this.modalBlocks(view, owner.browserId)) event.preventDefault()', 'if (false) event.preventDefault()'],
  staleOwner: ['if (this.browsers.nativeOwner(browserId)?.view !== view) return false', 'if (false) return false'],
  scrimChrome: ['const x = Math.max(bounds.x, browser.x), y = Math.max(bounds.y, browser.y)', 'const x = bounds.x, y = bounds.y']
} as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...original, plugins: [{ name: 'native-modal-presentation-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.NATIVE_MODAL_MUTATION as keyof typeof changes | undefined
  if (!name || relative(root, id) !== owner) return
  assert.ok(changes[name])
  const [needle, replacement] = changes[name]
  const occurrences = source.split(needle).length - 1
  assert.equal(occurrences, 1)
  const changed = source.replace(needle, replacement)
  if (process.env.NATIVE_MODAL_HITS) appendFileSync(process.env.NATIVE_MODAL_HITS,
    JSON.stringify({ name, file: owner, occurrences, source: sha(source), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/native-overlay-surfaces.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
