import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
assert.ok(branch.startsWith('feat/settings-liquid-motion-'), 'Source mutations require the owned feature worktree, never main')
const pane = 'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx'
const config = 'apps/desktop/scripts/fixtures/settings-liquid-motion/vitest.mutations.config.mts'
const proofPaths = [config, 'apps/desktop/scripts/verify-settings-prompts-source-mutations.mjs',
  'apps/desktop/scripts/fixtures/settings-liquid-motion/vitest.config.mts',
  'apps/desktop/scripts/fixtures/settings-liquid-motion/product-dom.tsx',
  'apps/desktop/scripts/fixtures/settings-prompts/vitest.config.mts',
  'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
  'apps/desktop/test/helpers/config-owner-fixture.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'vitest.setup.ts',
  ...['liquid', 'library', 'save', 'source-mutations'].map(name => `apps/desktop/test/settings-prompts-${name}.test.tsx`)]
const hash = source => createHash('sha256').update(source).digest('hex')
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const execute = promisify(execFile)
const directory = path.join(root, '.bagakit/design/settings-liquid-motion/prompt-source-mutations', `run-${Date.now()}-${randomUUID()}`)
await fs.mkdir(directory, { recursive: true })
const original = await fs.readFile(path.join(root, pane), 'utf8')
function replaceOne(before, after) {
  assert.equal(original.split(before).length - 1, 1, `One owning Source anchor: ${before}`)
  return original.replace(before, after)
}
const variants = [
  { id: 'selection-disconnected', source: replaceOne('selected={selectedId}', 'selected={null}'),
    test: 'keeps one decorative surface and one native textarea connected across real object selection', matcher: /expected .* to be 'one'/s },
  { id: 'active-hard-true', source: replaceOne('active={active}', 'active={true}'),
    test: 'releases the host resize sentinel while inactive and reconnects the same visited host', matcher: /Inactive Prompt releases its host resize sentinel/ },
  { id: 'textarea-remounted', source: replaceOne('<ComposerTextarea ', '<ComposerTextarea key={selectedId} '),
    test: 'keeps one decorative surface and one native textarea connected across real object selection', matcher: /expected .*textarea.* to be .*textarea/s },
  { id: 'status-always-saved', source: replaceOne('data-prompt-status={promptStatus}', 'data-prompt-status="saved"'),
    test: 'derives the selected object status from its draft while the whole library remains the save owner', matcher: /expected 'saved' to be 'unsaved'/ }
]
assert.equal(variants.length, 4)
const proof = Object.fromEntries(await Promise.all(proofPaths.map(async file => {
  const bytes = await fs.readFile(path.join(root, file)), snapshot = path.join(directory, 'proof', file)
  await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.writeFile(snapshot, bytes)
  return [file, hash(bytes)]
})))
let baselineInputs
const receipt = { schema: 'agentmux.prompt-dom-source-mutations.v1', passed: false, root, branch,
  productFile: pane, originalSHA256: hash(original), proofInputs: proof, runs: [] }
async function run(name, variant) {
  const at = path.join(directory, name)
  await fs.mkdir(at, { recursive: true })
  let exitCode = 0, stdout = '', stderr = ''
  try {
    const result = await execute('pnpm', ['exec', 'vitest', 'run', '--config', config,
      '--reporter=json', '--outputFile', path.join(at, 'vitest.json')], {
      cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_PROMPT_MUTATION_EVIDENCE: at },
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    stdout = result.stdout; stderr = result.stderr
  } catch (error) {
    exitCode = typeof error.code === 'number' ? error.code : -1
    stdout = error.stdout ?? ''; stderr = error.stderr ?? ''
  }
  await fs.writeFile(path.join(at, 'run.log'), stdout + stderr)
  const report = await json(path.join(at, 'vitest.json'))
  assert.equal(report.numTotalTests, 20, `${name}: exact nonempty owning test collection`)
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.equal(assertions.length, 20, `${name}: actual test assertions are nonempty`)
  const inputs = await json(path.join(at, 'source-inputs.json'))
  const loaded = (await fs.readFile(path.join(at, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loaded.length > 0, `${name}: actual loaded Source collection is nonempty`)
  for (const [file, digest] of Object.entries(inputs)) {
    const seen = loaded.filter(record => record.file === file)
    assert.ok(seen.length > 0, `${name}: actual product/owner Source loaded: ${file}`)
    assert.ok(seen.every(record => record.sha256 === digest), `${name}: all actual loads use the captured Source`)
    const bytes = await fs.readFile(path.join(root, file))
    assert.equal(hash(bytes), digest, `${name}: no Source drift during tests`)
    const snapshot = path.join(at, 'source', file)
    await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.writeFile(snapshot, bytes)
  }
  if (!baselineInputs) baselineInputs = inputs
  else assert.deepEqual(inputs, { ...baselineInputs, [pane]: hash(variant?.source ?? original) }, `${name}: only the one owning Pane changes`)
  const afterProof = Object.fromEntries(await Promise.all(proofPaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
  assert.deepEqual(afterProof, proof, `${name}: tests and proof inputs never change with product mutation`)
  let failure
  if (variant) {
    assert.notEqual(exitCode, 0, `${name}: actual Source mutant remained GREEN`)
    const owning = assertions.filter(value => value.status === 'failed' && value.title === variant.test)
    assert.equal(owning.length, 1, `${name}: the exact owning test fails`)
    failure = owning[0]
    assert.ok(failure.failureMessages.some(message => message.includes('AssertionError') && variant.matcher.test(message)),
      `${name}: the specific owning assertion fails, never setup/compile/collection`)
  } else {
    assert.equal(exitCode, 0, `${name}: see the preserved run.log`)
    assert.equal(report.numPassedTests, 20)
    assert.equal(report.numFailedTests, 0)
  }
  receipt.runs.push({ name, outcome: variant ? 'AssertionRED' : 'GREEN', exitCode, collectedTests: 20,
    sourceInputs: inputs, reportSHA256: hash(await fs.readFile(path.join(at, 'vitest.json'))),
    loadedSourceSHA256: hash(await fs.readFile(path.join(at, 'loaded-source.jsonl'))), failure })
  console.log(`${name}: ${variant ? 'AssertionRED' : 'GREEN'} (20 tests)`)
}
const lockPath = path.join(root, '.bagakit/design/settings-liquid-motion/sourcewriter.lock')
const lock = await fs.open(lockPath, 'wx')
let inFlight
try {
  await run('control')
  for (const variant of variants) {
    assert.equal(hash(await fs.readFile(path.join(root, pane))), hash(original), 'Only pristine owned Source enters mutation')
    await fs.writeFile(path.join(root, pane), variant.source); inFlight = variant
    await run(variant.id, variant)
    assert.equal(hash(await fs.readFile(path.join(root, pane))), hash(variant.source), 'Exact restore cannot overwrite a concurrent edit')
    await fs.writeFile(path.join(root, pane), original); inFlight = undefined
  }
  await run('restored')
  receipt.passed = true
} finally {
  try {
    if (inFlight && hash(await fs.readFile(path.join(root, pane))) === hash(inFlight.source)) await fs.writeFile(path.join(root, pane), original)
    receipt.exactRestore = hash(await fs.readFile(path.join(root, pane))) === hash(original)
    receipt.passed = receipt.passed && receipt.exactRestore
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  } finally {
    await lock.close()
    await fs.unlink(lockPath)
  }
  assert.equal(receipt.exactRestore, true, 'Owned product Source must be exactly restored without overwriting concurrent work')
  console.log(JSON.stringify({ directory, passed: receipt.passed, exactRestore: receipt.exactRestore }))
}
