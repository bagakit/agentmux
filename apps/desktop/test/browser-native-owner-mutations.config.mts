import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const guard = 'entry.inputShield?.isCurrentFor(entry.view)'
const current = 'this.page === page && this.current() && !this.contents.isDestroyed()'
const changes = {
  retired: { file: 'browser-view-manager.ts', from: guard, to: 'entry.inputShield && !entry.inputShield.contents.isDestroyed()' },
  isolated: { file: 'browser-view-manager.ts', from: guard, to: 'entry.inputShield?.isolated' },
  wrongPage: { file: 'browser-native-input-shield.ts', from: current, to: 'this.current() && !this.contents.isDestroyed()' },
  retiredCurrent: { file: 'browser-native-input-shield.ts', from: current, to: 'this.page === page && !this.contents.isDestroyed()' }
} as const
export default defineConfig({ ...original, plugins: [{ name: 'native-shield-owner-mutation', enforce: 'pre', transform(source, id) {
  const name = process.env.NATIVE_SHIELD_MUTATION as keyof typeof changes | undefined
  if (!name) return
  assert.ok(changes[name], 'Select an actual native shield owner mutation')
  const mutation = changes[name], file = 'apps/desktop/src/main/' + mutation.file
  if (!id.endsWith('/' + file)) return
  assert.equal(source.split(mutation.from).length - 1, 1, 'The actual ownership mutation must hit exactly once')
  const changed = source.replace(mutation.from, mutation.to)
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.NATIVE_SHIELD_HITS) appendFileSync(process.env.NATIVE_SHIELD_HITS,
    JSON.stringify({ name, file, occurrences: 1, source: sha(source), changed: sha(changed) })+'\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/browser-page-action-feedback.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
