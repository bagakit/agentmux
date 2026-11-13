import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { nativeProcessBirth } from '../dist/agent-native-process.js'
import { terminate } from '../scripts/fixtures/a2a-agent-behavior/process.mjs'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { launchPrivateA2aProof } from '../scripts/lib/a2a-private-model-proof.mjs'

const root = resolve(import.meta.dirname, '../../..'), temporary = join(root, '.tmp'), exec = promisify(execFile)

test('requires an installed Core before starting a model or creating execution evidence', async () => {
  await mkdir(temporary, { recursive: true })
  const scope = await mkdtemp(join(temporary, 'a2a-launch-scope-')), name = basename(scope), originalExitCode = process.exitCode
  try {
    await assert.rejects(launchPrivateA2aProof({ repository: root, sourceInputs: [], name,
      coordinatorEntry: join(scope, 'unreachable.mjs'), executableName: join(scope, 'not-a-model') }), /requires an installed Core/u)
    assert.deepEqual((await readdir(temporary)).filter(file => file.startsWith(name + '-')), [])
  } finally {
    process.exitCode = originalExitCode
    for (const file of await readdir(temporary)) if (file.startsWith(name + '-')) await rm(join(temporary, file), { recursive: true, force: true })
    await rm(scope, { recursive: true, force: true })
  }
})

test('the actual prepare-only consumer remains read-only and never launches its model', async () => {
  await mkdir(temporary, { recursive: true })
  const executions = async () => (await readdir(temporary)).filter(file => file.startsWith('a2a-reference-agent-flow-')).sort()
  const before = await executions()
  const { stdout } = await exec(process.execPath, ['packages/core/scripts/verify-a2a-reference-agent-flow.mjs', '--prepare-only'], { cwd: root })
  const facts = JSON.parse(stdout)
  assert.equal(facts.modelStarted, false)
  assert.equal(typeof facts.authFileAvailable, 'boolean')
  assert.ok(facts.sourceHashes['packages/core/scripts/lib/a2a-private-model-proof.mjs'])
  assert.deepEqual(await executions(), before)
})


// Exercise the coordinator's real CLI owner without starting its model entrypoint.
const coordinator = new URL('../scripts/fixtures/a2a-reference-agent/coordinator.mjs', import.meta.url).href
const fsBoundary = 'data:text/javascript,' + encodeURIComponent([
  "export * from 'node:fs/promises'",
  "import {writeFile as original} from 'node:fs/promises'",
  "export async function writeFile(path,...args) {const fault=globalThis[Symbol.for('agentmux.private-cli-receipt-test-fault')];if(fault&&path===fault.path&&++fault.writes===3)throw Object.assign(new Error('owned receipt test fault'),{code:'ENOSPC'});return original(path,...args)}"
].join('\n'))
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'node:fs/promises' && context.parentURL === coordinator ? { url: fsBoundary, shortCircuit: true } : next(specifier, context)
}, load(url, context, next) {
  const loaded = next(url, context)
  if (url !== coordinator) return loaded
  const source = String(loaded.source), marker = 'const config = JSON.parse'
  assert.equal(source.split(marker).length, 2)
  return { ...loaded, source: source.slice(0, source.indexOf(marker)) + '\nexport {startPrivateCli,privateFailure}\n' }
} })
let startPrivateCli, privateFailure
try { ({ startPrivateCli, privateFailure } = await import(coordinator)) } finally { hook.deregister() }

test('a normal owned CLI can complete beyond the old fifteen-second observation window', { skip: process.platform !== 'darwin' }, async () => {
  const scope = await mkdtemp(join(temporary, 'a2a-slow-cli-')), receipt = join(scope, 'process.json')
  const command = startPrivateCli(process.execPath, ['-e', 'setTimeout(() => console.log(JSON.stringify({ok:true})),16000)'], { cwd: scope }, receipt, nativeProcessBirth)
  try {
    await assert.doesNotReject(async () => assert.deepEqual(JSON.parse((await command.completed).stdout), { ok: true }), 'A normal owned CLI may run longer than 15 seconds')
    const original = JSON.parse(await readFile(receipt, 'utf8'))
    assert.equal(original.processId, command.child.pid); assert.equal(original.processIdentity.pid, command.child.pid)
    assert.equal(original.processIdentity.exited, true)
  } finally { await terminate(command.child); await rm(scope, { recursive: true, force: true }) }
})

test('a failed CLI retains its original error and confirmed exit receipt', { skip: process.platform !== 'darwin' }, async () => {
  const scope = await mkdtemp(join(temporary, 'a2a-failed-cli-')), receipt = join(scope, 'process.json')
  const command = startPrivateCli(process.execPath, ['-e', 'process.exitCode=7'], { cwd: scope }, receipt, nativeProcessBirth)
  try {
    await assert.rejects(command.completed, error => error.code === 7 && error.signal === null)
    const original = JSON.parse(await readFile(receipt, 'utf8'))
    assert.equal(original.processId, command.child.pid); assert.equal(original.processIdentity.pid, command.child.pid)
    assert.equal(original.processIdentity.exited, true)
  } finally { await terminate(command.child); await rm(scope, { recursive: true, force: true }) }
})


test('an exit-receipt write failure preserves and redacts the original CLI error and output', { skip: process.platform !== 'darwin' }, async () => {
  const scope = await mkdtemp(join(temporary, 'a2a-cli-receipt-failure-')), receipt = join(scope, 'process.json')
  const key = Symbol.for('agentmux.private-cli-receipt-test-fault')
  globalThis[key] = { path: receipt, writes: 0 }
  const command = startPrivateCli(process.execPath, ['-e', 'process.stdout.write("credential-marker out");process.stderr.write("credential-marker err");process.exitCode=7'], { cwd: scope }, receipt, nativeProcessBirth)
  try {
    let failure
    await assert.rejects(command.completed, error => { failure = error; return error instanceof AggregateError })
    assert.ok(failure.errors.some(error => error.code === 'ENOSPC'))
    const original = failure.errors.find(error => error.code === 7)
    assert.equal(original.stdout, 'credential-marker out'); assert.equal(original.stderr, 'credential-marker err')
    const saved = privateFailure(failure, text => text.replaceAll('credential-marker', '[redacted]'))
    const cli = saved.errors.find(error => error.code === 7)
    assert.equal(cli.stdout, '[redacted] out'); assert.equal(cli.stderr, '[redacted] err')
    assert.match(cli.stack, /Command failed/u)
    assert.ok(!JSON.stringify(saved).includes('credential-marker'))
  } finally { delete globalThis[key]; await terminate(command.child); await rm(scope, { recursive: true, force: true }) }
})
