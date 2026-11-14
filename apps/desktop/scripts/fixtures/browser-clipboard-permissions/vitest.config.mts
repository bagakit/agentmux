import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import base from '../browser-webauthn-accounts/vitest.owning.config.mts'
import { clipboardPermissionMutations } from '../../browser-clipboard-permissions-mutations.mjs'

const coreSourceRoot = new URL('../../../../../packages/core/', import.meta.url)
const coreSourceAliases = Object.entries(JSON.parse(readFileSync(new URL('package.json', coreSourceRoot), 'utf8')).exports as Record<string, { import: string }>)
  .filter(([key]) => key !== '.')
  .map(([key, entry]) => ({
    find: '@agentmux/core/' + key.slice(2),
    replacement: fileURLToPath(new URL(entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'), coreSourceRoot))
  })).sort((a, b) => b.find.length - a.find.length)

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, resolve: { alias: [
  { find: /^@agentmux\/core$/, replacement: root + 'packages/core/src/index.ts' },
  ...coreSourceAliases
] }, plugins: [{ name: 'browser-clipboard-source-mutation', enforce: 'pre', transform(source: string, id: string) {
  const name = process.env.AGENTMUX_CLIPBOARD_MUTATION
  if (!name) return
  const mutation = clipboardPermissionMutations.find(candidate => candidate.name === name)
  assert.ok(mutation, 'Select one declared clipboard mutation')
  if (relative(root, id.split('?')[0]!) !== mutation.path) return
  let changed = source
  for (const [before, after] of mutation.edits) { assert.equal(changed.split(before).length - 1, 1); changed = changed.replace(before, after) }
  assert.ok(process.env.AGENTMUX_CLIPBOARD_HITS)
  appendFileSync(process.env.AGENTMUX_CLIPBOARD_HITS, JSON.stringify({ name, path: mutation.path, sourceSHA256: sha(source), loadedSHA256: sha(changed), productionWritten: false }) + '\n')
  return { code: changed, map: null }
} }], test: { ...base.test, passWithNoTests: false } }
