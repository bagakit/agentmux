import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

export default defineConfig({ ...original, plugins: [{ name: 'actual-native-owner-cost-mutation', enforce: 'pre', transform(source, id) {
  if (!process.env.NATIVE_OWNER_SCAN_MUTATION || !id.endsWith('/apps/desktop/src/main/browser-view-manager.ts')) return
  const name = process.env.NATIVE_OWNER_SCAN_MUTATION
  assert.ok(name === 'scan' || name === 'trust-index', 'Select an actual owner lookup mutation')
  const [from, replacement] = name === 'scan'
    ? ['const browserId = this.browserIdsByView.get(view)', 'const browserId = [...this.entries.values()].find(entry => entry.view === view)?.id']
    : ['return owner?.view === view ? owner : undefined', 'return owner']
  assert.equal(source.split(from).length, 2, 'The actual owner lookup mutation must hit exactly once')
  const changed = source.replace(from, replacement)
  const sha = (input: string) => createHash('sha256').update(input).digest('hex')
  if (process.env.NATIVE_OWNER_SCAN_HITS) appendFileSync(process.env.NATIVE_OWNER_SCAN_HITS, JSON.stringify({
    name, file: 'apps/desktop/src/main/browser-view-manager.ts', source: sha(source), changed: sha(changed), occurrences: 1
  }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/browser-view-manager.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
