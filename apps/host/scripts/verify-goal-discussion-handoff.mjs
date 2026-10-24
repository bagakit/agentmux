import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handoffMutations } from '../test/goal-discussion-handoff-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/goal-discussion-handoff')
await mkdir(directory, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['apps/host/scripts/verify-goal-discussion-handoff.mjs', 'apps/host/test/goal-discussion-handoff-native.test.ts',
  'apps/desktop/test/goal-discussion-handoff.test.tsx', 'apps/desktop/test/helpers/current-demand-product.tsx',
  'apps/desktop/test/goal-discussion-launcher-metadata.test.tsx', 'apps/desktop/test/helpers/injected-context-core.ts',
  'apps/desktop/test/helpers/isolate-core-environment.ts',
  'apps/host/test/vitest.goal-discussion-handoff.config.mts', 'apps/host/test/goal-discussion-handoff-node-loader.mjs',
  'apps/host/test/goal-discussion-handoff-mutations.mjs', 'apps/host/test/mobile-web-node-loader.mjs',
  'apps/host/test/fixtures/mobile-web-host.mjs', 'packages/core/test/helpers/headless-runtime-fixture.ts',
  'packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/types.ts', 'apps/desktop/src/shared/contracts.ts',
  'packages/core/test/fixtures/fake-codex-cli.mjs', 'packages/identity/dist/runtime-source.js',
  'apps/host/resources/bin/agentmux-workspace-move', 'packages/core/dist/control-endpoint-listener-worker.js',
  'packages/demand/dist/src/demand-store.js', 'packages/demand/dist/src/discussion.js',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
const inputs = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await readFile(resolve(root, path)))])))
const { staleDistComplaint } = await import(pathToFileURL(resolve(root, 'vitest.dist-freshness.ts')).href)
assert.equal(await staleDistComplaint(resolve(root, 'packages/identity'), 'dist/runtime-source.js'), null,
  'The generated native identity recipe must be the current published artifact; all changed handoff owners load their Source')
const expectedInputs = await inputs(), owners = new Map(), runs = []
const nativeTest = 'apps/host/test/goal-discussion-handoff-native.test.ts', desktopTest = 'apps/desktop/test/goal-discussion-handoff.test.tsx'
const metadataTest = 'apps/desktop/test/goal-discussion-launcher-metadata.test.tsx'
const conditions = { node: process.version, platform: process.platform, architecture: process.arch,
  scope: 'Private official ctxmux, Source Node Host, Unix CLI and encrypted Relay, plus actual Renderer store/preload/trusted Main IPC with controlled Electron transport and Native IO. No user data, installed App or physical phone.' }
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
for (const label of ['baseline', ...Object.keys(handoffMutations), 'restored']) {
  const mutant = Object.hasOwn(handoffMutations, label), loaded = resolve(directory, label + '-loaded.jsonl')
  const result = resolve(directory, label + '-result.json'), facts = resolve(directory, label + '-facts.jsonl')
  await Promise.all([writeFile(loaded, ''), writeFile(facts, '')])
  const desktopOnly = label === 'source-before-durable-ack' || label === 'pending-launcher-projection' || label === 'metadata-blocks-native'
  const selected = label === 'source-before-durable-ack' ? [desktopTest, '-t', 'does not delete the actual saved source when a successful write loses its durable ACK field']
    : label === 'pending-launcher-projection' ? [desktopTest, '-t', 'the original Desktop Launcher.*lost-reply']
    : label === 'metadata-blocks-native' ? [metadataTest, '-t', 'when Launcher metadata is missing']
    : mutant ? [nativeTest] : []
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.goal-discussion-handoff.config.mts',
      '--reporter=json', '--outputFile=' + result, ...selected], { cwd: root,
      env: { ...env, GOAL_HANDOFF_MUTANT: mutant ? label : '', GOAL_HANDOFF_LOADED: loaded, GOAL_HANDOFF_FACTS: facts }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null, 'The verifier process must complete without an external termination')
  const report = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(report.numTotalTests, !mutant ? 13 : label === 'metadata-blocks-native' ? 4 : desktopOnly ? 8 : 1, 'The original exact consumer set must be collected')
  assert.equal(report.numPassedTests + report.numFailedTests, mutant ? 1 : 13, 'Every selected consumer must execute; skipped or empty fixtures cannot qualify')
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const row of evaluations) {
    assert.ok(['node-loader', 'vitest-transform'].includes(row.surface))
    const key = row.surface + ':' + row.path, previous = owners.get(key)
    if (previous) assert.equal(row.originalSHA256, previous, 'The actual evaluated production owner changed during this proof: ' + key)
    else owners.set(key, row.originalSHA256)
  }
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The changed owner must be detected')
    assert.ok(failures.some(test => test.failureMessages.some(message => /AssertionError|__VITEST_REJECTS__|__VITEST_RESOLVES__/u.test(message))),
      'The actual consumer must reject changed behavior; timeout, import and collection failures are not mutation evidence')
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact changed owner must actually be evaluated')
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 13)
    for (const path of ['packages/core/src/client.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/spatial-state.ts', 'apps/host/src/goal-discussion-bindings.ts', 'apps/host/src/goal-discussion-launcher.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/goal-discussions.ts',
      'apps/desktop/src/main/goal-discussion-handoff.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
      'apps/desktop/src/renderer/src/lib/goal-discussion-handoff.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/renderer/src/store.ts',
      'apps/mobile/src/goals/MobileGoalsSurface.tsx', 'apps/mobile/src/navigation/MobileZoneWorkface.tsx'])
      assert.ok(evaluations.some(row => row.path === path), 'The real owner must execute: ' + path)
  }
  const observations = (await readFile(facts, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (!desktopOnly) assert.ok(observations.some(row => row.cleanup?.length && row.cleanup.every(item => item.state === 'confirmed')), 'Private native processes must have confirmed cleanup')
  if (!mutant) assert.ok(observations.some(row => row.originalRun?.runId && row.retainedBinding?.recipient.agentSessionId && row.newBinding?.recipient.agentSessionId &&
    row.launcher?.explicitRecord?.agentSessionId && row.nativeLauncher?.refusedBeforeWrite === true && row.nativeLauncher?.creation?.spatialIntent?.tabId &&
    row.nativeLauncher?.recovered?.agentSessionId && row.nativeLauncher.actualNativeRuns.length === 1 && row.inputAcknowledged === true && row.ownerBefore && row.ownerAfter && row.ownerBefore !== row.ownerAfter),
  'A nonempty original Run, old and new canonical recipients, both Launcher creation producers and recovery after a refused owned write must be observed')
  assert.deepEqual(await inputs(), expectedInputs, 'The actual fixture and executable inputs must remain unchanged')
  runs.push({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests, evaluations, observations })
  process.stdout.write(JSON.stringify({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.goal-discussion-handoff-proof.v1', conditions,
  inputs: expectedInputs, originalSourceHashes: Object.fromEntries(owners), runs }, null, 2) + '\n')
