import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
import { schedulingMutations } from '../scripts/native-overlay-scheduling-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ ...original, plugins: [{ name: 'native-overlay-scheduling-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.NATIVE_HANDOFF_MUTATION
  if (!name) return
  const mutation = schedulingMutations.find(candidate => candidate.name === name)
  assert.ok(mutation, 'Select a declared scheduling mutation')
  if (relative(root, id.split('?')[0]!) !== mutation.path) return
  let changed = source
  for (const [before, after] of mutation.edits) {
    assert.equal(changed.split(before).length - 1, 1, 'Select one actual owner anchor')
    changed = changed.replace(before, after)
  }
  assert.ok(process.env.NATIVE_HANDOFF_HITS)
  appendFileSync(process.env.NATIVE_HANDOFF_HITS, JSON.stringify({ name, path: mutation.path,
    sourceSHA256: sha(source), loadedSHA256: sha(changed), productionWritten: false }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: [
  'apps/desktop/test/native-overlay-regions.test.ts',
  'apps/desktop/test/native-overlay-geometry.test.ts',
  'apps/desktop/test/native-overlay-chrome.test.tsx',
  'apps/desktop/test/native-overlay-modal.test.ts'
], maxWorkers: 1, passWithNoTests: false } })
