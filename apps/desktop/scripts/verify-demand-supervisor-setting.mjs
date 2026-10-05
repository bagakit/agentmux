import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.join(root, '.tmp/demand-supervisor-setting', String(globalThis.crypto.randomUUID()))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['apps/desktop/src/shared/goals-preferences.ts', 'apps/desktop/src/shared/config-edit.ts',
  'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/settings/modules/goals.ts',
  'apps/desktop/src/renderer/src/components/settings/GoalsSettingsPane.tsx', 'apps/desktop/src/renderer/src/components/settings/modules/goals.tsx',
  'apps/desktop/test/demand-supervisor-setting.test.tsx', 'apps/desktop/scripts/fixtures/demand-supervisor-setting/vitest.config.mts']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await fs.readFile(path.join(root, file)))])))
const mutations = [
  { id: 'effective-default', file: files[0], before: 'requesterAsSupervisor: value?.requesterAsSupervisor ?? true', after: 'requesterAsSupervisor: value?.requesterAsSupervisor ?? false' },
  { id: 'strict-config-type', file: files[2], before: 'requesterAsSupervisor: z.boolean().optional()', after: 'requesterAsSupervisor: z.unknown().optional()' },
  { id: 'authored-optional-merge', file: files[1], before: "if (path === 'goals.requesterAsSupervisor') return value ?? resolveGoalsPreferences(undefined).requesterAsSupervisor", after: "if (path === 'goals.requesterAsSupervisor') return value ?? false" },
  { id: 'main-scalar-save', file: files[3], before: '(config, requesterAsSupervisor) => ({ ...config, goals: { ...config.goals, requesterAsSupervisor } })', after: '(config, requesterAsSupervisor) => ({ ...config, goals: { ...config.goals } })' },
  { id: 'gui-authored-choice', file: files[4], before: 'requesterAsSupervisor: submittedSupervisor.value', after: 'requesterAsSupervisor: savedView.requesterAsSupervisor' }
]
await fs.mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.demand-supervisor-setting.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source: await hashes(), baseline: null, mutations: [],
  boundary: 'Current Source CLI executable, private public socket, typed public service, Main Settings scalar, durable ConfigOwner/Store and actual SettingsPanel. Synthetic Runtime transport; no user configuration or Agent Run touched. Visual review is separate.' }
async function run(name, mutant) {
  const loaded = path.join(evidence, name + '.loaded.ndjson'), log = path.join(evidence, name + '.log')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/demand-supervisor-setting/vitest.config.mts']
  // The new executable case bundles current Source. The legacy bin case requires published
  // dist, intentionally absent in this private Source worktree; it cannot replace this proof.
  args.push('-t', mutant ? 'requester Supervisor setting' : '^(?!ordinary CLI executable)')
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_DAILY_GOAL_PROOF: loaded,
    ...(mutant ? { AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutant) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const [exitCode, signal] = await once(child, 'exit'); clearTimeout(timer)
  await fs.writeFile(log, output)
  const rows = (await fs.readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(rows.length, 'Empty loaded graph')
  return { exitCode, signal, assertionRed: /AssertionError|expected .* to/.test(output),
    testsPassed: Number(/Tests\s+(\d+) passed/.exec(output)?.[1] ?? 0),
    log: path.relative(root, log), logSHA256: digest(output), loaded: path.relative(root, loaded), rows }
}
try {
  const baseline = await run('baseline'); receipt.baseline = { ...baseline }; delete receipt.baseline.rows
  assert.equal(baseline.exitCode, 0); assert.equal(baseline.signal, null); assert.ok(baseline.testsPassed >= 22)
  for (const file of files.slice(0, 6)) assert.ok(baseline.rows.some(row => row.file === file), 'Actual loaded owner/consumer ' + file)
  for (const mutation of mutations) {
    assert.equal((await fs.readFile(path.join(root, mutation.file), 'utf8')).split(mutation.before).length, 2, 'One mutant anchor ' + mutation.id)
    const result = await run(mutation.id, mutation)
    receipt.mutations.push({ id: mutation.id, ...result }); delete receipt.mutations.at(-1).rows
    assert.notEqual(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.assertionRed, true, mutation.id + ' must fail a product assertion')
    assert.ok(result.rows.some(row => row.file === mutation.file && row.consumer === 'actual-loaded-mutant' && row.beforeSha256 !== row.afterSha256))
    console.log(mutation.id + ': assertion RED')
  }
  assert.deepEqual(await hashes(), receipt.source, 'Settings Source changed during proof')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, evidence: path.relative(root, path.join(evidence, 'receipt.json')), mutations: receipt.mutations.length }))
assert.equal(receipt.passed, true, receipt.error?.message)
