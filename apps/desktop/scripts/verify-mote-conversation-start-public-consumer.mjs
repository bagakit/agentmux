import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = await realpath(resolve(import.meta.dirname, '../../..'))
const directory = resolve(root, process.argv[2] ?? '.bagakit/mote-conversation-start/root-ui-gate')
await mkdir(directory, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const config = 'apps/desktop/test/mote-conversation-start-public-consumer.config.mts'
const test = 'apps/desktop/test/mote-conversation-start-public-consumer.test.tsx'
const mutations = ['welcome-query-dropped', 'welcome-unaccepted-clears-draft', 'welcome-late-acceptance-steals-reading', 'menu-unconfirmed-hides-recovery',
  'rollover-ipc-decision-dropped', 'rollover-treated-as-send-error', 'rollover-unconfirmed-archives', 'rollover-foreign-start-archives',
  'rollover-not-discovered', 'rollover-multiple-auto-selects', 'rollover-target-unchecked', 'closed-history-needs-live-occurrence', 'discussion-merges-same-session-periods',
  'period-upper-dropped', 'period-wire-assembly-dropped', 'period-source-key-collapsed', 'hidden-period-reads']
// Baseline/restored run all cases. Each mutant runs its exact real consumer oracle.
const targets = {
  'welcome-query-dropped': 'actual Desktop welcome',
  'welcome-unaccepted-clears-draft': 'a real unconfirmed deferred input',
  'welcome-late-acceptance-steals-reading': 'late canonical first-Query',
  'menu-unconfirmed-hides-recovery': 'a real unconfirmed deferred input',
  'rollover-ipc-decision-dropped': 'actual Desktop ordered queue',
  'rollover-treated-as-send-error': 'actual Desktop ordered queue',
  'rollover-unconfirmed-archives': 'automatic Main setup',
  'rollover-foreign-start-archives': 'an accepted different manual start',
  'rollover-not-discovered': 'actual Desktop ordered queue',
  'rollover-multiple-auto-selects': 'multiple actual Core rollover',
  'rollover-target-unchecked': 'the actual Mote workface refuses',
  'closed-history-needs-live-occurrence': 'a closed historical occurrence',
  'discussion-merges-same-session-periods': 'same Host and SID',
  'period-upper-dropped': 'actual shared period reader',
  'period-wire-assembly-dropped': 'actual shared period reader',
  'period-source-key-collapsed': 'actual shared period reader',
  'hidden-period-reads': 'hidden shared periods'
}
const receipt = { schema: 'agentmux.mote-start-root-ui-proof.v1', passed: false, source: {}, runs: [], sourceDrift: [],
  boundary: 'Actual Desktop welcome, original RuntimeController main-input method and IPC result envelope, ordered store queue, MoteWorkface/AgentSessionComposer, Main action helper and shared bounded period consumers render in happy-dom. Original Host content/Files CAS/dialogue/Core and Unix ControlServer RPC own all business results. Automatic due decisions come from original Claude human input and ordered native hook start/end plus actual saved idle policy. Only deterministic Runtime byte I/O and ancillary browser/platform presentation are controlled. Native Claude JSONL frames come from the original SDK reader. No real user Session/Run, model, full Electron IPC transport, visual/browser geometry or installation claim.' }
for (const file of [config, test, 'apps/host/test/helpers/mote-conversation-start-fixture.ts',
  'packages/core/test/helpers/creation-input-owner.ts', 'packages/core/test/fixtures/native-history-session.ts',
  'apps/desktop/test/vitest.mote-context.config.mts', 'apps/desktop/scripts/verify-mote-conversation-start-public-consumer.mjs',
  'packages/core/dist/control-endpoint-listener-worker.js']) receipt.source[file] = hash(await readFile(resolve(root, file)))
const pinned = new Map()
let expectedTests = 0

async function run(label, mutation) {
  const output = resolve(directory, label + '.json'), log = resolve(directory, label + '.log'), loaded = resolve(directory, label + '.loaded.ndjson')
  await writeFile(loaded, '')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', output]
  if (mutation) args.push('--testNamePattern', targets[mutation])
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
      AGENTMUX_TEST_ROOT_UI_MUTATION: mutation ?? '', AGENTMUX_TEST_ROOT_UI_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
    child.once('error', reject)
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, stderr }) })
  })
  await writeFile(log, result.stdout + result.stderr)
  let report
  try { report = JSON.parse(await readFile(output, 'utf8')) } catch { throw Error(label + ': no original Vitest JSON result; inspect ' + log) }
  const modules = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(modules.length > 0, label + ': empty loaded production source is not evidence')
  const evaluated = modules.filter(item => item.stage === 'evaluated')
  assert.ok(evaluated.length > 0, label + ': transformed-only source was never evaluated')
  for (const item of modules) {
    assert.equal(item.fileSHA256, item.originalSHA256, label + ': expected direct original source, not a dist/map substitute')
    const current = hash(await readFile(resolve(root, item.path)))
    if (current !== item.fileSHA256) receipt.sourceDrift.push({ stage: label, path: item.path, loaded: item.fileSHA256, current })
    if (!pinned.has(item.path)) pinned.set(item.path, item.fileSHA256)
    else if (pinned.get(item.path) !== item.fileSHA256) receipt.sourceDrift.push({ stage: label, path: item.path, baseline: pinned.get(item.path), current: item.fileSHA256 })
  }
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  const executed = assertions.filter(item => item.status === 'passed' || item.status === 'failed')
  const failed = assertions.filter(item => item.status === 'failed')
  if (!mutation) {
    assert.equal(result.code, 0, label + ': baseline/restored must pass; inspect ' + log)
    assert.equal(report.success, true)
    assert.ok(report.numTotalTests >= 13 && assertions.length >= 13, label + ': empty or incomplete scenario selection')
    assert.equal(failed.length, 0)
    expectedTests ||= report.numTotalTests
  } else {
    assert.notEqual(result.code, 0, mutation + ': behavior mutant survived')
    assert.equal(result.signal, null, mutation + ': process termination is not an assertion kill')
    assert.equal(report.numTotalTests, expectedTests, mutation + ': import/collection failure is not a kill')
    assert.equal(executed.length, 1, mutation + ': run exactly one nonempty original consumer oracle')
    assert.ok(executed[0].fullName.includes(targets[mutation]), mutation + ': wrong consumer scenario')
    assert.ok(failed.length > 0, mutation + ': no actual failed consumer assertion')
    for (const failure of failed) {
      const messages = failure.failureMessages.join('\n')
      assert.match(messages, /\bAssertionError\b/u, mutation + ': require behavioral assertion RED, not an import/runtime failure')
      assert.doesNotMatch(messages, /timed out|SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Failed to load|Transform failed/u)
    }
    const changed = modules.filter(item => item.mutation === mutation)
    assert.ok(changed.some(item => item.stage === 'loaded' && item.originalSHA256 !== item.loadedSHA256), mutation + ': mutation did not alter loaded source')
    assert.ok(changed.some(item => item.stage === 'evaluated' && item.originalSHA256 !== item.loadedSHA256), mutation + ': mutation was not evaluated')
  }
  const run = { label, mutation: mutation ?? null, code: result.code, totalTests: report.numTotalTests,
    selectedScenario: mutation ? targets[mutation] : null, executedTests: executed.length,
    passedTests: report.numPassedTests, failedTests: report.numFailedTests,
    failedAssertions: failed.map(item => ({ name: item.fullName, messages: item.failureMessages })),
    result: output, log, loaded, mutated: evaluated.filter(item => item.mutation === mutation),
    source: Object.fromEntries(evaluated.map(item => [item.path, item.fileSHA256])) }
  receipt.runs.push(run)
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(label + ': ' + (mutation ? 'assertion RED' : 'GREEN') + ' (' + executed.length + ' actual tests)\n')
}

try {
  await run('baseline')
  for (const mutation of mutations) await run(mutation, mutation)
  await run('restored')
  assert.deepEqual(receipt.sourceDrift, [], 'Production candidate changed during proof; the old receipt cannot sign the new source')
  receipt.source = { ...receipt.source, ...Object.fromEntries(pinned) }
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(resolve(directory, 'receipt.json') + '\n')
}
