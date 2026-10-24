import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fixturePath } from './lib/fixture-values.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/terminal-switch-observation')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
const config = 'apps/desktop/test/terminal-switch-observation.config.mts'
const sources = [
  'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts',
  'apps/desktop/src/renderer/src/components/TerminalView.tsx',
  'apps/desktop/src/renderer/src/lib/terminal-attachment-observation.ts',
  'apps/desktop/src/renderer/src/lib/client-incident-recorder.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/shared/session-observation-result.ts',
  'apps/desktop/test/terminal-initial-observation-recovery.test.tsx',
  'apps/desktop/test/terminal-observation-error.test.ts',
  'apps/desktop/test/fixtures/terminal-observation-bridge.ts',
  'apps/desktop/test/fixtures/input-authority-pty.mjs', config,
  'apps/desktop/test/session-continuity-core.config.mts',
  'packages/core/test/helpers/headless-runtime-fixture.ts',
  'packages/core/test/fixtures/headless-runtime-worker.mjs',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/hosted-value.ts',
  ...['index', 'client', 'headless-runtime', 'hosted-runtime-service', 'hosted-client', 'public-rpc-client',
    'hosted-value', 'ctxmux-run-adapter', 'terminal-continuation', 'control-endpoint-publication',
    'control-endpoint-listener-worker'].map(name => `packages/core/dist/${name}.js`),
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`,
  'vitest.setup.ts', 'apps/desktop/scripts/verify-terminal-switch-observation.mjs'
]
const mutants = ['first-visible-read', 'finite-window', 'subject-validation']
const expectedTests = {
  'first-visible-read': 'visible observation restores the original agent on first visible mount',
  'finite-window': 'visible observation gives persistent bad transfer one independent read per visible window',
  'subject-validation': 'retains the first returned lease but refuses a foreign Run continuation'
}
async function checkInputs(inputs) {
  assert.ok(Object.keys(inputs).length > 0, 'Nonempty candidate inputs')
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Candidate changed: ' + file)
}
async function checkCleanup(activity) {
  assert.ok(activity.some(row => row.event === 'allocated'), 'Private Runtime must actually be allocated')
  assert.ok(!activity.some(row => row.event === 'cleanup-error'), 'Private fixture cleanup must succeed')
  for (const row of activity.filter(row => ['allocated', 'bridge'].includes(row.event))) {
    await assert.rejects(access(row.root), 'Private fixture root must be removed')
    if (row.event === 'allocated') {
      assert.ok(activity.some(released => released.event === 'released' && released.root === row.root), 'Original fixture release receipt')
      for (const pid of [row.nativePid, row.ownerPid]) {
        assert.ok(Number.isInteger(pid) && pid > 1, 'Exact private process identity')
        assert.throws(() => process.kill(pid, 0), 'Private process must exit')
      }
    }
  }
  for (const { pid } of activity.filter(row => row.event === 'run' && row.pid !== null)) assert.throws(() => process.kill(pid, 0), 'Original private PTY must exit')
}

if (process.argv.includes('--run')) {
  await mkdir(evidence, { recursive: true })
  const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const results = []
  for (const mutation of [null, ...mutants]) {
    const name = mutation ?? 'baseline'
    const report = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '-loaded.jsonl')
    const resources = resolve(evidence, name + '-resources.jsonl'), logPath = resolve(evidence, name + '.log')
    const cache = await mkdtemp(fixturePath('tmp/amsw-'))
    await writeFile(loaded, ''); await writeFile(resources, '')
    let log = ''
    try {
      const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
        '--reporter=json', '--outputFile=' + report], { cwd: root, env: { ...process.env,
        AGENTMUX_TERMINAL_SWITCH_MUTATION: mutation ?? '', AGENTMUX_TERMINAL_SWITCH_LOADED: loaded,
        AGENTMUX_CONTINUITY_MUTATION: '', AGENTMUX_TEST_CLIENT_ENTRY: '', AGENTMUX_TEST_RPC_CLIENT_ENTRY: '',
        AGENTMUX_TEST_OWNER_ENTRY: resolve(root, 'packages/core/test/fixtures/headless-runtime-worker.mjs'),
        TERMINAL_RECOVERY_RESOURCES: resources, TMPDIR: cache }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
      const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
      await writeFile(logPath, log)
      const suite = await json(report), consumed = await lines(loaded), activity = await lines(resources)
      const assertions = suite.testResults.flatMap(file => file.assertionResults)
      assert.ok(assertions.some(test => ['passed', 'failed'].includes(test.status)), 'Nonempty mounted consumer assertions')
      assert.ok(!suite.numRuntimeErrorTestSuites, 'Suite or loading failure cannot kill a mutant')
      for (const file of ['apps/desktop/src/renderer/src/components/TerminalView.tsx',
        'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts',
        'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
        'apps/desktop/src/preload/index.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts']) {
        assert.ok(consumed.some(row => row.file === file), 'Production consumer must load: ' + file)
      }
      await checkCleanup(activity)
      if (mutation) {
        assert.equal(code, 1, 'Mutant must fail through a semantic assertion')
        assert.ok(consumed.some(row => row.mutation === mutation && row.sourceSHA256 !== row.loadedSHA256), 'Original source mutation must load')
        assert.ok(assertions.some(test => test.status === 'failed' && test.fullName.includes(expectedTests[mutation]) &&
          test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), 'Named consumer assertion must reject this mutant')
      } else {
        assert.equal(code, 0, log); assert.equal(suite.success, true)
        assert.ok(activity.some(row => row.event === 'original-preserved' && row.corruptedTransfers > 0 && row.acceptedInputBytes === 0), 'Real carrier failure must preserve the original PID and zero input')
      }
      results.push({ name, passed: suite.numPassedTests, failed: suite.numFailedTests, report: relative(root, report),
        reportSHA256: hash(await readFile(report)), loadedSHA256: hash(await readFile(loaded)), resourcesSHA256: hash(await readFile(resources)), privateCleanup: true })
      process.stdout.write(name + ': ' + (mutation ? 'semantic mutant rejected' : 'mounted consumers passed') + '\n')
    } finally { await rm(cache, { recursive: true, force: true }) }
  }
  await checkInputs(inputs)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.terminal-switch-observation-proof.v1', status: 'passed', inputs, results,
    scope: 'Bounded visible first-lease observation through private Native/Unix/Hosted/Main IPC/mounted TerminalView. Does not identify the original field protocol error or certify installation.' }, null, 2) + '\n')
} else {
  const receipt = await json(resolve(evidence, 'receipt.json'))
  assert.equal(receipt.status, 'passed'); await checkInputs(receipt.inputs)
  assert.deepEqual(receipt.results.map(row => row.name), ['baseline', ...mutants])
  for (const row of receipt.results) {
    assert.ok(row.name === 'baseline' ? row.passed > 0 && row.failed === 0 : row.failed > 0)
    assert.equal(hash(await readFile(resolve(root, row.report))), row.reportSHA256)
    assert.equal(hash(await readFile(resolve(evidence, row.name + '-loaded.jsonl'))), row.loadedSHA256)
    assert.equal(hash(await readFile(resolve(evidence, row.name + '-resources.jsonl'))), row.resourcesSHA256)
    assert.equal(row.privateCleanup, true)
  }
  process.stdout.write('Terminal switch observation: exact candidate proof verified\n')
}
