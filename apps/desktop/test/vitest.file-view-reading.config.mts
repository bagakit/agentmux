import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import sources from './vitest.file-sources.config.mts'
export const readingMutations = {
  graph: ['apps/desktop/src/renderer/src/store.ts', '  setFileViewReading(binding, position, initial = false) {', '  setFileViewReading(binding, position, initial = false) { set(state => ({tabs: {...state.tabs}}))'],
  qualified: ['apps/desktop/src/main/workbench-user-state.ts', 'if (!this.readingReady.has(fileViewReadingOwnerKey(owner)))', 'if (false)'],
  witness: ['apps/desktop/src/main/workbench-user-state.ts', '        await this.readReadingCurrent(owner)\n', ''],
  stale: ['apps/desktop/src/renderer/src/lib/file-view-reading.ts', 'if (!source.current()) return false', 'if (false) return false'],
  receipt: ['apps/desktop/src/renderer/src/store.ts', 'receipt.contentDigest !== digest || ', ''],
  baseline: ['apps/desktop/src/renderer/src/store.ts', '    if (initial) { if (!value.position)', '    if (false) { if (!value.position)'],
  capture: ['apps/desktop/src/renderer/src/store.ts', 'if (value.binding.current()) value.binding.capture()', 'if (value.binding.current()) void 0'],
  namespace: ['apps/desktop/src/main/workbench-user-state.ts', '        await (this.io.syncDirectory ?? syncDirectory)(dirname(dirname(path)))', ''],
  root: ['apps/desktop/src/main/workbench-user-state.ts', 'const result = (this.readingTails.get(key) ?? Promise.resolve()).then(action)', 'const result = this.queue(action)']
} as const
export default defineConfig({ ...sources, plugins: [{ name: 'file-view-reading-loaded-mutations', enforce: 'pre', transform(source, id) {
  const name = process.env.FILE_VIEW_READING_MUTATION as keyof typeof readingMutations | undefined
  if (!name) return
  assert.ok(readingMutations[name]); const [file, before, after] = readingMutations[name]
  if (relative(process.cwd(), id.split('?')[0]!) !== file) return
  assert.equal(source.split(before).length - 1, 1, 'One actual source mutation anchor')
  const code = source.replace(before, after), sha = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.FILE_VIEW_READING_HITS) appendFileSync(process.env.FILE_VIEW_READING_HITS, JSON.stringify({ name, file, original: sha(source), loaded: sha(code) }) + '\n')
  return { code, map: null }
} }], test: { ...sources.test, include: ['apps/desktop/test/file-view-reading.test.ts'], testTimeout: 10000 } })
