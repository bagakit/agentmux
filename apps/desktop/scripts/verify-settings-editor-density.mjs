import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.tmp/settings-editor-density', randomUUID())
const mode = 'settings-editor-density'
const sources = [`apps/desktop/scripts/fixtures/${mode}/scenario.cjs`, 'apps/desktop/scripts/verify-settings-editor-density.mjs']
const editor = 'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx'
const hash = content => createHash('sha256').update(content).digest('hex')
await mkdir(directory, { recursive: true })
console.log(directory)

async function run(stage, sourceOverrides) {
  const output = join(directory, stage)
  const receipt = await qualify(output, false, false, { modes: [mode], sources, sourceOverrides })
  assert.deepEqual(receipt.remainingPrivateProcesses, [])
  assert.equal(receipt.privateRootRemoved, true)
  assert.equal(receipt.processes.length, 1, JSON.stringify(receipt.failure))
  const scenario = JSON.parse(await readFile(join(output, `${mode}.json`), 'utf8'))
  return { receipt, scenario }
}

const original = await readFile(join(root, editor), 'utf8')
if (!process.argv.includes('--capture-only')) {
  const label = '<div className="prompt-editor__instruction">'
  const input = '<ComposerTextarea variant="compact" expanded='
  assert.equal(original.split(label).length, 2)
  assert.equal(original.split(input).length, 2)
  const mutated = original.replace(label, '<div className="prompt-editor__instruction" style={{ border: \'1px solid var(--focus-line)\' }}>')
    .replace(input, '<ComposerTextarea variant="compact" style={{ minHeight: 144 }} expanded=')
  const file = join(directory, 'mutated-editor.tsx')
  await writeFile(file, mutated)
  const { receipt, scenario } = await run('oversized-double-focus', { [editor]: { file, originalSha256: hash(original), sha256: hash(mutated) } })
  assert.notEqual(receipt.completed, true)
  assert.equal(receipt.originalInputs[editor]?.sha256, hash(original), 'The real product module consumed the private override')
  assert.equal(scenario.failure?.name, 'AssertionError', JSON.stringify(scenario.failure))
  assert.match(scenario.failure.message, /Prompt wide: two written lines, one focus indicator/)
  assert.match(scenario.failure.message, /compact: false/)
  assert.match(scenario.failure.message, /openLabel: false/)
  assert.equal(await readFile(join(root, editor), 'utf8'), original)
}
const { receipt, scenario } = await run('control')
assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
assert.equal(receipt.source[editor]?.sha256, hash(original))
assert.ok(scenario.surface.exact && scenario.commits.length > 0)
assert.ok(receipt.png.length >= 10)
console.log(JSON.stringify({ passed: true, evidence: directory, sourceIdentity: receipt.sourceIdentity, editors: scenario.editors }))
