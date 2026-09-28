import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const mode = process.argv[2]
if (mode === '--materials') {
  // Root owns the actual-renderer material mutations; do not substitute a source scan for them.
  const result = spawnSync(process.execPath, [path.join(root, 'apps/desktop/scripts/verify-settings-glass-prompts.mjs'), '--materials-mutant'], { cwd: root, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
assert.ok(mode === '--library' || mode === '--save', 'Choose --library, --save or --materials')
assert.ok(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim().startsWith('feat/settings-glass-prompts'), 'Source mutations only run in the explicitly owned feature worktree')
const sourceFile = path.join(root, 'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx')
const source = await fs.readFile(sourceFile, 'utf8')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const originalHash = hash(source)
const evidence = path.join(root, '.bagakit/design/settings-glass-prompts', 'mutations-' + mode.slice(2), 'run-' + Date.now() + '-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
await fs.writeFile(path.join(evidence, 'owning-source.tsx'), source)
const receipt = { schema: 'agentmux.settings-prompts-source-mutations.v1', passed: false, root, mode,
  source: { path: path.relative(root, sourceFile), sha256: originalHash },
  environment: { dependencies: 'existing symlink modules; no installation or shared dist build', verifyDepsBeforeRun: process.env.pnpm_config_verify_deps_before_run ?? 'caller must disable automatic install for this linked worktree' }, runs: [] }
function replaceExactlyOnce(before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Nonempty exact production block: ' + before)
  return source.replace(before, after)
}
const libraryMutants = [
  { id: 'fixed-clock-identity', before: 'crypto.randomUUID()', after: 'Date.now()' },
  { id: 'new-name-focus', before: 'focusNewName.current = true', after: 'focusNewName.current = false' },
  { id: 'query-consumption', before: ".join(' ').toLowerCase().includes(normalizedQuery)", after: ".join(' ').toLowerCase().includes('')" },
  { id: 'whole-library-create', before: "({ ...current, [id]: { id, keyword: '', label: '', body: '' } })", after: "({ [id]: { id, keyword: '', label: '', body: '' } })" },
  { id: 'state-usage-preview', before: 'prompt.states?.length ? <div>', after: 'false ? <div>' }
]
const saveMutants = [
  { id: 'whole-library-expectation', before: 'onSave(normalized, Object.values(submitted.expected))', after: 'onSave(normalized, Object.values(submitted.value))' },
  { id: 'whole-library-change-facts', before: 'const changedCount = drafts.filter((candidate) => !configValuesEqual(candidate, Object.hasOwn(resource.expected, candidate.id) ? resource.expected[candidate.id] : undefined)).length', after: 'const changedCount = 0' },
  { id: 'pending-deletion-facts', before: 'const deletedCount = Object.keys(resource.expected).filter((id) => !Object.hasOwn(resource.value, id)).length', after: 'const deletedCount = 0' },
  { id: 'authored-undo-snapshot', before: 'const restored = recentDelete.prompt', after: 'const restored = resource.expected[recentDelete.prompt.id]!' },
  { id: 'undo-other-drafts', before: 'Object.hasOwn(current, restored.id) ? current : { ...current, [restored.id]: restored }', after: '({ [restored.id]: restored })' },
  { id: 'undo-same-id-guard', before: 'Object.hasOwn(current, restored.id) ? current : { ...current, [restored.id]: restored }', after: '({ ...current, [restored.id]: restored })' },
  { id: 'later-deletion-survives-save', before: 'current === deletionAtStart && current && Object.hasOwn(submitted.expected, current.prompt.id) && !Object.hasOwn(submitted.value, current.prompt.id) ? null : current', after: 'current ? null : current' },
  { id: 'pending-input-preserved', before: 'submitted.finish(committed ? Object.fromEntries(normalized.map((candidate) => [candidate.id, candidate])) : undefined)', after: 'resource.setValue((current) => committed ? Object.fromEntries(normalized.map((candidate) => [candidate.id, candidate])) : current)\n    submitted.finish(committed ? Object.fromEntries(normalized.map((candidate) => [candidate.id, candidate])) : undefined)' }
]
const mutants = mode === '--library' ? libraryMutants : saveMutants
assert.ok(mutants.length > 0, 'This task has actual production block mutants')
const test = mode === '--library' ? 'settings-prompts-library.test.tsx' : 'settings-prompts-save.test.tsx'
const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/settings-prompts/vitest.config.mts', `apps/desktop/test/${test}`, '--reporter=json']
async function run(id, red = false) {
  const outputFile = path.join(evidence, id + '.json')
  const result = spawnSync('pnpm', [...args, '--outputFile=' + outputFile], { cwd: root, env: process.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  await fs.writeFile(path.join(evidence, id + '.log'), result.stdout + '\n' + result.stderr)
  if (result.error) throw result.error
  const report = JSON.parse(await fs.readFile(outputFile, 'utf8'))
  assert.ok(report.numTotalTests > 0, 'Actual mounted tests were collected')
  const failures = report.testResults.flatMap((file) => file.assertionResults.filter((test) => test.status === 'failed'))
  if (red) {
    assert.notEqual(result.status, 0, 'Mutant fails')
    assert.ok(failures.length > 0, 'Mutant exercises actual assertions')
    assert.ok(failures.some((failure) => failure.failureMessages.some((message) => message.includes('AssertionError'))), 'Assertion RED, not compile/import/environment failure')
  } else {
    assert.equal(result.status, 0, result.stderr)
    assert.equal(report.numFailedTests, 0)
    assert.ok(report.numPassedTests > 0)
  }
  receipt.runs.push({ id, outcome: red ? 'assertion-red' : 'green', tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, sourceSha256: hash(await fs.readFile(sourceFile)), failures: failures.map((failure) => failure.fullName) })
  console.log(JSON.stringify(receipt.runs.at(-1)))
}
try {
  await run('control')
  for (const mutant of mutants) {
    assert.equal(hash(await fs.readFile(sourceFile)), originalHash, 'Original Source still current before mutation')
    const mutated = replaceExactlyOnce(mutant.before, mutant.after)
    await fs.writeFile(path.join(evidence, mutant.id + '-source.tsx'), mutated)
    await fs.writeFile(sourceFile, mutated)
    try { await run(mutant.id + '-red', true) }
    finally {
      assert.equal(hash(await fs.readFile(sourceFile)), hash(mutated), 'Only owned mutant Source is restored; never overwrite an unexpected edit')
      await fs.writeFile(sourceFile, source)
    }
  }
  assert.equal(hash(await fs.readFile(sourceFile)), originalHash)
  await run('restored')
  receipt.passed = true
} finally {
  receipt.restored = hash(await fs.readFile(sourceFile)) === originalHash
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ evidence, passed: receipt.passed, restored: receipt.restored }))
}
