import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
assert.ok(process.argv.length === 3 && ['--events', '--reading'].includes(process.argv[2]), 'Choose exactly --events or --reading.')
const scope = process.argv[2].slice(2), reading = scope === 'reading'
const evidence = join(root, '.local/terminal-reconnect-continuity', scope)
await mkdir(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
const config = 'apps/desktop/test/terminal-reconnect-continuity.config.mts'
const sources = [
  'apps/desktop/src/renderer/src/lib/session-events.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/components/TerminalView.tsx',
  'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/test/renderer-session-events.test.ts', 'apps/desktop/test/terminal-initial-observation-recovery.test.tsx',
  'apps/desktop/test/fixtures/terminal-connection-event.ts', 'apps/desktop/test/fixtures/terminal-observation-bridge.ts',
  'apps/desktop/test/fixtures/input-authority-pty.mjs', 'apps/desktop/test/helpers/isolate-core-environment.ts',
  'apps/desktop/test/tsconfig.terminal-reconnect.json', config,
  'apps/desktop/test/session-continuity-core.config.mts', 'packages/core/test/hook-postcommit-observation.vitest.config.mts',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/fixtures/headless-runtime-worker.mjs',
  'packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/hosted-value.ts',
  ...['index', 'client', 'headless-runtime', 'hosted-runtime-service', 'hosted-client', 'public-rpc-client',
    'hosted-value', 'ctxmux-run-adapter', 'terminal-continuation'].map(name => 'packages/core/dist/' + name + '.js'),
  'packages/core/vendor/ctxmux/' + process.platform + '-' + process.arch + '/bin/ctxmuxd',
  'apps/desktop/scripts/verify-terminal-reconnect-continuity.mjs'
]
if (reading) sources.push('apps/desktop/test/terminal-reconnect-reading.test.tsx',
  'apps/desktop/test/terminal-checkpoint-continuation.test.tsx',
  'apps/desktop/test/tsconfig.terminal-reconnect-reading.json', 'apps/desktop/src/renderer/src/global.d.ts',
  'apps/desktop/src/renderer/src/lib/terminal-viewport-memory.ts', 'apps/desktop/src/renderer/src/lib/terminal-viewport-sync.ts',
  'apps/desktop/src/renderer/src/lib/terminal-replay.ts', 'packages/core/src/terminal-continuation.ts')
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(join(root, file)))])))
const receiptPath = join(evidence, 'receipt.json')
const nativePattern = 'connection restoration|holds the actual first request|cancels a hidden'
const apiPattern = 'connection restoration|actual Desktop API|keeps resize|routes reader|owns duplicate|takes a current|allows last|delivers remaining|routes nonempty'
const attempts = reading ? [
  { name: 'baseline-reading', target: 'reading', pattern: 'live reconnect' },
  { name: 'baseline-checkpoint', target: 'checkpoint', pattern: 'retains the existing drain|held reconnect suffix|keeps the canvas on|reports an invalid reconnect' },
  { name: 'baseline-native', target: 'native', pattern: 'live reconnect preserves the original Native' },
  { name: 'replace-reading', target: 'reading', mutation: 'replace-reading', pattern: 'live reconnect keeps the original reading intent' },
  { name: 'restore-replace-reading', target: 'reading', pattern: 'live reconnect keeps the original reading intent' },
  { name: 'false-recovery', target: 'reading', mutation: 'false-recovery', pattern: 'honest ahead continuation' },
  { name: 'restore-false-recovery', target: 'reading', pattern: 'honest ahead continuation' },
  { name: 'clear-history-gap', target: 'reading', mutation: 'clear-history-gap', pattern: 'does not clear an older unfilled' },
  { name: 'restore-clear-history-gap', target: 'reading', pattern: 'does not clear an older unfilled' }
] : [
  { name: 'baseline-api', target: 'api', pattern: apiPattern },
  { name: 'baseline-native', target: 'native', pattern: nativePattern },
  { name: 'missing-connection', target: 'native', mutation: 'missing-connection', pattern: 'connection restoration' },
  { name: 'restore-missing-connection', target: 'native', pattern: 'connection restoration' },
  { name: 'foreign-host', target: 'api', mutation: 'foreign-host', pattern: 'connection restoration reaches' },
  { name: 'restore-foreign-host', target: 'api', pattern: 'connection restoration reaches' }
]
async function verify(receipt) {
  assert.equal(receipt.scope, scope); assert.equal(receipt.status, 'passed')
  assert.deepEqual(receipt.inputs, inputs, 'Proof binds the exact scoped source, compiled owner and official Runtime')
  assert.deepEqual(receipt.results.map(row => row.name), attempts.map(attempt => attempt.name))
  assert.equal(hash(await readFile(join(evidence, 'typecheck.log'))), receipt.typecheck.sha256)
  for (const row of receipt.results) {
    for (const [key, digest] of Object.entries(row.artifacts)) {
      assert.equal(hash(await readFile(join(evidence, key))), digest, 'Original report/log/load/resource artifact')
    }
    assert.equal(row.cleanup, true)
    assert.ok(row.tests > 0, 'Nonempty consumer proof')
  }
}
try {
  const previous = await json(receiptPath)
  if (JSON.stringify(previous.inputs) === JSON.stringify(inputs)) {
    await verify(previous)
    process.stdout.write('Terminal reconnect ' + scope + ': exact source-bound proof reused\n')
    process.exit(0)
  }
} catch (error) { if (error.code !== 'ENOENT') throw error }

const project = reading ? 'apps/desktop/test/tsconfig.terminal-reconnect-reading.json' : 'apps/desktop/test/tsconfig.terminal-reconnect.json'
const typecheck = execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
  '--project', project, '--noEmit'], { cwd: root, encoding: 'utf8' })
await writeFile(join(evidence, 'typecheck.log'), typecheck)
const results = []
for (const attempt of attempts) {
  const report = join(evidence, attempt.name + '.json'), loaded = join(evidence, attempt.name + '-loaded.jsonl')
  const resources = join(evidence, attempt.name + '-resources.jsonl'), logPath = join(evidence, attempt.name + '.log')
  const cache = await mkdtemp(join(tmpdir(), 'amx-r16-proof-'))
  await writeFile(loaded, ''); await writeFile(resources, '')
  let log = ''
  try {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile=' + report], { cwd: root, env: { ...process.env,
      AGENTMUX_TERMINAL_RECONNECT_SCOPE: scope, AGENTMUX_TERMINAL_RECONNECT_TARGET: attempt.target,
      AGENTMUX_TERMINAL_RECONNECT_PATTERN: attempt.pattern, AGENTMUX_TERMINAL_RECONNECT_MUTATION: attempt.mutation ?? '',
      AGENTMUX_TERMINAL_RECONNECT_LOADED: loaded, AGENTMUX_TERMINAL_RECONNECT_CACHE: cache,
      AGENTMUX_CONTINUITY_MUTATION: '', AGENTMUX_TEST_CLIENT_ENTRY: '', AGENTMUX_TEST_RPC_CLIENT_ENTRY: '',
      AGENTMUX_TEST_OWNER_ENTRY: join(root, 'packages/core/test/fixtures/headless-runtime-worker.mjs'),
      TERMINAL_RECOVERY_RESOURCES: resources, TMPDIR: cache }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
    await writeFile(logPath, log)
    const suite = await json(report), consumed = await lines(loaded), activity = await lines(resources)
    const assertions = suite.testResults.flatMap(file => file.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
    assert.ok(assertions.length > 0, 'Nonempty selected consumers'); assert.ok(!suite.numRuntimeErrorTestSuites, 'Loading failure is not a business rejection')
    for (const file of ['apps/desktop/src/renderer/src/lib/session-events.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
      ...(attempt.target === 'native' ? ['apps/desktop/src/renderer/src/components/TerminalView.tsx',
        'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts', 'apps/desktop/src/main/runtime-controller.ts',
        'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'packages/core/src/hosted-client.ts'] : [])]) {
      assert.ok(consumed.some(row => row.file === file), 'Actual production consumer loads: ' + file)
    }
    assert.ok(!activity.some(row => row.event === 'cleanup-error'), 'Every private cleanup stage succeeds')
    if (attempt.target === 'native') {
      assert.ok(activity.some(row => row.event === 'allocated'), 'The official Native was actually allocated')
      for (const row of activity.filter(item => item.event === 'allocated' || item.event === 'bridge')) {
        await assert.rejects(access(row.root), 'Test-owned root must be removed')
        if (row.event === 'allocated') {
          assert.ok(activity.some(item => item.event === 'released' && item.root === row.root), 'Exact cleanup receipt')
          for (const pid of [row.nativePid, row.ownerPid]) assert.throws(() => process.kill(pid, 0), 'Test owner exits')
        }
      }
      for (const row of activity.filter(item => item.event === 'run')) {
        assert.ok(Number.isInteger(row.pid) && row.pid > 1, 'Exact private PTY PID')
        assert.throws(() => process.kill(row.pid, 0), 'The private PTY exits after test cleanup')
      }
      for (const row of activity.filter(item => item.event === 'released')) {
        for (const pid of [row.nativePid, row.ownerPid]) assert.throws(() => process.kill(pid, 0), 'The final private owner exits after reconnect cleanup')
      }
    }
    if (attempt.mutation) {
      assert.equal(code, 1, 'Source mutant must fail')
      assert.ok(consumed.some(row => row.mutation === attempt.mutation && row.loadedSHA256 !== row.sourceSHA256), 'Actual production mutant loaded')
      assert.ok(assertions.some(test => test.status === 'failed' && test.fullName.includes(reading ? 'live reconnect' : 'connection restoration') &&
        test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), 'Named behavior kills the mutant')
    } else {
      assert.equal(code, 0, log); assert.equal(suite.success, true)
      if (attempt.target === 'native') assert.ok(activity.some(row =>
        reading ? row.event === 'reading-reconnected' && row.snapshots > 0 && row.selected === true &&
          row.originalReading === true && row.liveOutput === true && row.acceptedInputBytes === 0
        : row.event === 'connection-restored' && row.liveOutput === true && row.acceptedInputBytes === 0 && row.reads === 4),
      'Original Run receives real post-reconnect output without input')
    }
    const artifacts = Object.fromEntries(await Promise.all([report, loaded, resources, logPath].map(async file => [
      relative(evidence, file), hash(await readFile(file))])))
    results.push({ name: attempt.name, tests: assertions.length, passed: suite.numPassedTests,
      failed: suite.numFailedTests, artifacts, cleanup: true })
    process.stdout.write(attempt.name + ': ' + (attempt.mutation ? 'business mutant rejected' : 'passed') + '\n')
  } finally { await rm(cache, { recursive: true, force: true }) }
}
for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, file))), digest, 'Scoped candidate stayed unchanged: ' + file)
const receipt = { schema: 'agentmux.terminal-reconnect-continuity.v1', scope, status: 'passed',
  candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs, results,
  typecheck: { command: 'tsc --project ' + project + ' --noEmit', sha256: hash(typecheck) },
  limitations: [reading ? 'Actual private semantic owner process restart; official Native/PTY, Run, xterm and read intent retained.'
    : 'Typed restored fact is injected only at the actual IPC transport fixture boundary; this does not claim a physical disconnect.',
    'Private official Native/PTY and actual Main/preload/API/TerminalView; no user Session or original historical acceptance is signed.',
    'Only named API dispatch cases are selected; the unrelated Store.initialize fixture is outside this Task.'] }
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
await verify(receipt)
process.stdout.write('Terminal reconnect ' + scope + ': original consumer, source mutants and cleanup verified\n')
