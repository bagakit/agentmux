import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

assert.equal(process.platform + '-' + process.arch, 'darwin-arm64', 'This proof requires its actual bundled Native')
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'package.json'))
const hash = source => createHash('sha256').update(source).digest('hex')
const directory = join(root, '.local/state/session-observation-retry'); await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-'))
const owners = ['packages/core/src/client.ts', 'packages/core/src/session-observation-retry.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client.ts',
  'packages/core/src/hosted-client-contract.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-server.ts',
  'packages/core/src/ctxmux-run-adapter.ts', 'packages/core/src/providers/codex-session-status.ts',
  'packages/core/src/control-endpoint-listener-worker.ts', 'apps/desktop/test/helpers/mote-diagnostics-cli.ts',
  'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/runtime-observation-admission.test.ts',
  'packages/core/test/session-observation-retry.integration.test.ts', 'packages/core/test/session-observation-retry.integration.config.mts',
  'packages/core/scripts/verify-session-observation-retry.mjs']
const original = new Map(await Promise.all(owners.map(async file => [file, await readFile(join(root, file), 'utf8')])))
const sourceSHA256 = Object.fromEntries([...original].map(([file, source]) => [file, hash(source)]))
const receipt = { schema: 'agentmux.session-observation-retry-gate.v1', passed: false, userRuntimeTouched: false,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceSHA256,
  boundary: 'Actual private ctxmux/6 generic Runs → actual Core/Unix RPC/Hosted refresh/status and real Codex protocol file observer; original 30s retry; exact reader loss and explicit Native reconnect. Source/epoch/cancel scheduler checks and 3 existing Core recovery-owner port counterexamples supplement this. Unexpected owned Native child exit is not physically exercised.',
  results: [], sourceStable: false }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
function mutate(file, from, to) {
  const source = original.get(file); assert.ok(source)
  assert.equal(source.split(from).length - 1, 1, 'Exact original owner anchor: ' + file)
  return { [file]: source.replace(from, to) }
}
const client = 'packages/core/src/client.ts', scheduler = 'packages/core/src/session-observation-retry.ts'
const native = 'exact Session observation retry: actual Native', temporal = 'exact Session observation retry: late source/epoch'
const variants = [
  { name: 'candidate', changes: {}, assertions: 6 },
  { name: 'auxiliary-reopens-global', changes: mutate(client,
    'this.connectionNeedsObservation = false\n      this.connectionHealthySince', 'this.connectionNeedsObservation = this.sessionObservationsUnconfirmed()\n      this.connectionHealthySince'), pattern: native, assertions: 1,
    reason: /auxiliary unknown must not reopen global recovery/u },
  { name: 'automatic-original-retry-withdrawn', changes: mutate(scheduler,
    'delete entry.timer; void this.run(entry)', 'delete entry.timer; /* Original automatic retry withdrawn. */'), pattern: native, assertions: 1,
    reason: /automatic exact source retry/u },
  { name: 'another-session-observer-borrowed', changes: mutate(client,
    "if (kind === 'native-status') return await this.ensureNativeStatusObservation(session, true) && current()",
    "if (kind === 'native-status') return await this.ensureNativeStatusObservation(this.registry.list().find(candidate => candidate.agentSessionId !== session.agentSessionId)!, true) && current()"), pattern: native, assertions: 1,
    reason: /automatic exact source retry/u },
  { name: 'late-epoch-result-admitted', changes: mutate(scheduler,
    'this.current(entry.target)\n  }', 'true\n  }'), pattern: temporal, assertions: 1,
    reason: /old connection epoch must not confirm current observation/u },
  { name: 'pending-reader-owner-not-cancelled', changes: mutate(scheduler,
    'entry.controller.abort()', '/* The original pending reader was not cancelled. */'), pattern: temporal, assertions: 1,
    reason: /owner release cancels its original pending reader/u },
  { name: 'shared-recovery-withdrawn', changes: mutate(client,
    'void this.reconnectLoop(epoch)\n  }\n\n  private async reconnectLoop', '/* Original shared Runtime recovery withdrawn. */\n  }\n\n  private async reconnectLoop'), pattern: 'automatically recovers a later transport loss', assertions: 1,
    reason: /AssertionError/u },
  { name: 'old-hook-owner-result-borrowed', changes: mutate(client,
    'if (previous) return previous.epoch === target.epoch && previous.source === source ? previous.pending :\n      previous.pending.then(() => this.restoreHookBinding(session))',
    'if (previous) return previous.pending'), pattern: 'exact Session observation retry: the next connection', assertions: 1,
    reason: /new connection Hook binding/u }
]
console.log('session-observation-retry-evidence=' + relative(root, attempt))
try {
  for (const variant of process.argv.includes('--mutations') ? variants : variants.slice(0, 1)) {
    const { name, changes } = variant, sources = join(attempt, name + '-sources.json'), loaded = join(attempt, name + '-loaded.jsonl')
    const report = join(attempt, name + '.json'), product = join(attempt, name + '-product.json')
    await writeFile(sources, JSON.stringify(changes))
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config',
        'packages/core/test/session-observation-retry.integration.config.mts', '--reporter=json', '--outputFile=' + report],
      { cwd: root, env: { ...process.env, AGENTMUX_SESSION_OBSERVATION_SOURCES: sources, AGENTMUX_SESSION_OBSERVATION_LOADED: loaded,
        AGENTMUX_SESSION_OBSERVATION_RECEIPT: product, ...(variant.pattern ? { AGENTMUX_SESSION_OBSERVATION_TEST_PATTERN: variant.pattern } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
    })
    await writeFile(join(attempt, name + '.log'), result.output)
    const parsed = JSON.parse(await readFile(report, 'utf8'))
    const assertions = parsed.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
    assert.equal(assertions.length, variant.assertions, 'Exact nonempty original consumer inventory: ' + name)
    const failures = assertions.filter(test => test.status === 'failed')
    const semanticRed = result.code === 1 && result.signal === null && failures.length === 1 &&
      failures.every(test => !test.failureMessages.some(message => /Test timed out|Hook timed out|ENOTEMPTY|cleanup/iu.test(message)) &&
        test.failureMessages.some(message => variant.reason?.test(message)))
    const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loads.length > 0, 'Actual source input closure is nonempty')
    for (const row of loads) {
      const source = await readFile(join(root, row.path), 'utf8')
      assert.equal(row.originalSha256, hash(source), 'Exact original source input: ' + row.path)
      assert.equal(row.sha256, hash(changes[row.path] ?? source), 'Exact effective source input: ' + row.path)
    }
    for (const file of Object.keys(changes)) assert.ok(loads.some(row => row.path === file), 'Changed actual consumer owner was loaded: ' + file)
    receipt.results.push({ name, code: result.code, signal: result.signal, assertions: assertions.length, semanticRed,
      loaded: Object.fromEntries(loads.map(row => [row.path, row.sha256])), failures: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (name === 'candidate') {
      assert.equal(result.code, 0, 'Original actual Native/Hosted observation consumer failed: ' + report)
      const facts = JSON.parse(await readFile(product, 'utf8'))
      assert.equal(facts.userRuntimeTouched, false); assert.equal(facts.automaticRetry, true)
      assert.equal(facts.readerLossRetainsRuntime, true); assert.equal(facts.explicitNativeReconnect, true)
      assert.equal(facts.originalRuns.length, 6); assert.equal(facts.unexpectedOwnedDaemonExit, 'not-exercised')
      receipt.product = facts
      for (const file of owners.filter(file => file.includes('/src/') && !file.endsWith('control-endpoint-listener-worker.ts')))
        assert.ok(loads.some(row => row.path === file), 'Actual product owner was consumed: ' + file)
    } else assert.ok(semanticRed, 'Mutation must fail its exact behavioral oracle: ' + name)
  }
  for (const [file, digest] of Object.entries(sourceSHA256)) assert.equal(hash(await readFile(join(root, file))), digest, 'Source stable: ' + file)
  receipt.sourceStable = true; receipt.passed = true
} finally { await save() }
console.log(JSON.stringify({ passed: true, receipt: join(attempt, 'receipt.json') }))
