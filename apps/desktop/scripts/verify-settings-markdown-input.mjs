import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.tmp/settings-markdown-input', randomUUID())
const mode = 'settings-markdown-input'
const sources = [
  'apps/desktop/scripts/fixtures/settings-editor-density/scenario-markdown.cjs',
  'apps/desktop/scripts/verify-settings-markdown-input.mjs'
]
const promptEditor = 'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx'
const composer = 'packages/client-ui/src/input/ComposerTextarea.tsx'
const hash = content => createHash('sha256').update(content).digest('hex')
await mkdir(directory, { recursive: true })
console.log(directory)

async function run(stage, sourceOverrides) {
  const output = join(directory, stage)
  const receipt = await qualify(output, false, false, { modes: [mode], sources, sourceOverrides, minify: 'esbuild' })
  assert.deepEqual(receipt.remainingPrivateProcesses, [])
  assert.equal(receipt.privateRootRemoved, true)
  // Keep the compiled identity, screenshots and raw receipts in place. Each stage releases
  // the reconstructable bundles once its isolated Electron process has exited.
  await rm(join(output, 'compiled'), { recursive: true, force: true })
  if (receipt.coreDirectory) await rm(join(output, receipt.coreDirectory), { recursive: true, force: true })
  assert.equal(receipt.processes.length, 1, JSON.stringify(receipt.failure))
  const process = receipt.processes[0]
  assert.ok(process.exitConfirmed && !process.timedOut, JSON.stringify(process))
  const scenario = JSON.parse(await readFile(join(output, `${mode}.json`), 'utf8'))
  return { receipt, scenario, process }
}

const original = await readFile(join(root, promptEditor), 'utf8')
const originalSha256 = hash(original)
const { receipt, scenario, process: control } = await run('control')
assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
assert.equal(control.exitCode, 0)
assert.equal(receipt.source[promptEditor]?.sha256, originalSha256)
assert.equal(receipt.source[composer]?.sha256, hash(await readFile(join(root, composer))))
assert.ok(scenario.surface.exact)
assert.ok(scenario.markdown.savedSource.includes('**behaviour**'))
assert.equal(scenario.disk.composerShortcuts.find(item => item.id === 'explain').body, scenario.markdown.savedSource,
  'The private ConfigStore writes the original Markdown source, including the trailing newline')
assert.equal(receipt.png.length, 4)

if (!process.argv.includes('--capture-only')) {
  const optIn = 'syntax="markdown"'
  assert.equal(original.split(optIn).length, 2, 'Mutate the unique opt-in at the actual Prompt consumer')
  const mutant = original.replace(optIn, '')
  const sha256 = hash(mutant)
  const file = join(directory, 'prompt-without-markdown-opt-in.tsx')
  await writeFile(file, mutant)
  const { receipt, scenario, process } = await run('without-opt-in', { [promptEditor]: { file, originalSha256, sha256 } })
  assert.equal(receipt.originalInputs[promptEditor]?.sha256, originalSha256)
  assert.equal(receipt.source[promptEditor]?.sha256, sha256, 'The compiled product consumed the private Source mutation')
  assert.notEqual(process.exitCode, 0)
  assert.equal(scenario.failure?.name, 'AssertionError', JSON.stringify(scenario.failure))
  assert.match(scenario.failure.message, /Prompt has one decorative Markdown projection/)
  assert.equal(await readFile(join(root, promptEditor), 'utf8'), original, 'The private mutation leaves the working tree intact')
}
console.log(JSON.stringify({ passed: true, evidence: directory, sourceIdentity: receipt.sourceIdentity, png: receipt.png }))
