import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// Only private copies are mutated. Native verification owns its own temporary
// Runtime/Session/daemon and never connects to the user's AgentMux instance.
const repository = resolve(import.meta.dirname, '../../..')
const output = resolve(process.argv[2] ?? join(repository, '.local/state/mote-startup-contract'))
await mkdir(output, { recursive: true })
const evidence = await mkdtemp(join(output, 'attempt-')), isolated = join(evidence, 'source')
const owner = 'apps/desktop/src/renderer/src/lib/mote-session-recovery.ts'
const startupTest = 'test/mote-startup-recovery.test.ts'
const uiConfig = 'apps/desktop/test/mote-session-recovery.config.mts'
const nativeConfig = 'apps/desktop/test/mote-recovery-native.config.mts'
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.mote-startup-contract.v1', passed: false, source: {}, isolatedInputs: {}, runs: [], callers: [],
  mutation: null, native: null, cleanup: null,
  boundary: 'Actual Renderer Store.initialize/on-open recovery owners with mocked Host bridge; isolated production Source mutation; separate private Core/Hosted/native restart with fixture CLI. No user App/Run, installed artifact, upstream model or long-term experience claim.' }
async function files(directory) {
  const entries = await readdir(join(repository, directory), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}
async function run(label, cwd, config, tests, expected, extraEnv = {}) {
  const report = join(evidence, label + '.json'), log = join(evidence, label + '.log')
  const args = [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...tests, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report]
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
  const status = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  await writeFile(log, text)
  const bytes = await readFile(report), result = JSON.parse(bytes)
  const entry = { label, command: [process.execPath, ...args], cwd: relative(repository, cwd), ...status,
    tests: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests,
    report: { path: relative(repository, report), sha256: hash(bytes) }, log: { path: relative(repository, log), sha256: hash(text) } }
  receipt.runs.push(entry)
  assert.equal(status.signal, null, 'Process termination is not behavioral proof: ' + label)
  assert.equal(result.numTotalTests, expected, 'The exact nonempty owning suite must execute: ' + label)
  return { entry, result }
}
function green(run) {
  const failures = run.result.testResults.flatMap(suite => [suite.message, ...suite.assertionResults.flatMap(test => test.failureMessages)]).filter(Boolean)
  assert.equal(run.entry.code, 0, failures.join('\n').slice(0, 1500))
  assert.equal(run.entry.failed, 0); assert.equal(run.entry.passed, run.entry.tests)
  assert.equal(run.result.success, true)
}
try {
  const capacity = await statfs(repository)
  receipt.availableBytes = Number(capacity.bavail) * Number(capacity.bsize)
  const trees = ['apps/desktop/src', 'apps/desktop/test/fixtures', 'apps/desktop/test/helpers',
    ...['core', 'demand', 'layout', 'identity', 'client-ui'].map(name => 'packages/' + name + '/src')]
  const selected = ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'vitest.setup.ts', 'test/fixture-values.mjs',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/test/mote-startup-recovery.test.ts', 'apps/desktop/test/mote-session-recovery.test.tsx',
    uiConfig, 'apps/desktop/test/selection-field.config.mts', 'apps/desktop/scripts/radix-overlay-aliases.ts',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'apps/desktop/scripts/lib/fixture-values.mjs',
    ...['core', 'demand', 'layout', 'identity', 'client-ui'].flatMap(name => ['package.json', 'tsconfig.json'].map(file => 'packages/' + name + '/' + file))]
  const nativeInputs = [nativeConfig, 'apps/desktop/test/mote-recovery-native.test.ts',
    'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/helpers/fixture-values.ts',
    'packages/core/test/fixtures/headless-runtime-worker.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs',
    'packages/core/src/ctxmux-artifact-contract.json', `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`,
    `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`,
    relative(repository, import.meta.filename)]
  const copiedInputs = [...new Set([...selected, ...(await Promise.all(trees.map(files))).flat()])].sort()
  // Supporting App imports are frozen to make this isolated candidate readable.
  // Unrelated Memory/visual edits do not become another startup acceptance gate.
  const bearing = [...new Set([...selected, ...nativeInputs, ...copiedInputs.filter(file => file.startsWith('packages/core/src/') || file.startsWith('packages/layout/src/')),
    owner, ...['session-state', 'mote-default-conversation', 'mote-quick-preferences', 'idle-agent-restore-policy',
      'desktop-spatial-state', 'workbench-persistence', 'session-presentation', 'scratch-topic-snapshots', 'space-agent-control']
      .map(name => 'apps/desktop/src/renderer/src/lib/' + name + '.ts'), 'apps/desktop/src/renderer/src/store.ts',
    ...['contracts', 'scratch-topics', 'mote-quick-mode', 'space-addresses'].map(name => 'apps/desktop/src/shared/' + name + '.ts'),
    'apps/desktop/test/fixtures/mote-workface.ts', 'apps/desktop/test/fixtures/mote-app.tsx',
    'apps/desktop/test/helpers/startup-observation-api-fixture.ts', 'apps/desktop/test/helpers/client-ui-render.tsx'])].sort()
  for (const file of bearing) receipt.source[file] = hash(await readFile(join(repository, file)))
  // A missing asset/compile is an infrastructure failure, never mutation RED.
  for (const tree of trees) await cp(join(repository, tree), join(isolated, tree), { recursive: true })
  for (const file of selected) { await mkdir(dirname(join(isolated, file)), { recursive: true }); await cp(join(repository, file), join(isolated, file)) }
  receipt.candidateBytes = 0
  for (const file of copiedInputs) {
    const bytes = await readFile(join(isolated, file)); receipt.isolatedInputs[file] = hash(bytes); receipt.candidateBytes += bytes.length
    if (receipt.source[file]) assert.equal(receipt.isolatedInputs[file], receipt.source[file], 'The isolated copy must match the exact startup/native candidate: ' + file)
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'apps/desktop/resources',
    ...['core', 'demand', 'layout', 'identity', 'client-ui'].map(name => 'packages/' + name + '/node_modules')]) {
    await mkdir(dirname(join(isolated, path)), { recursive: true }); await symlink(join(repository, path), join(isolated, path), 'dir')
  }
  const store = await readFile(join(isolated, 'apps/desktop/src/renderer/src/store.ts'), 'utf8')
  for (const anchor of ['const disposeMoteStartupRecovery = beginMoteStartupRecovery()',
    '.then(() => recoverScratchConversationsAtStartup())', 'await recoverMoteConversationAtStartup(current)',
    'recovery = await api.sessions.recover(current.control, current.workspacePath, operationId)']) {
    const line = store.split('\n').findIndex(value => value.includes(anchor))
    assert.ok(line >= 0, 'Actual initialize/membership/Core bridge caller missing: ' + anchor)
    receipt.callers.push({ path: 'apps/desktop/src/renderer/src/store.ts', line: line + 1, anchor })
  }
  green(await run('baseline', isolated, uiConfig, [startupTest, 'test/mote-session-recovery.test.tsx'], 20))
  const original = await readFile(join(isolated, owner), 'utf8')
  const from = "return topic.id === PMO_TEAMS_TOPIC_ID ? 'startup' :"
  assert.equal(original.split(from).length, 2, 'One exact mandatory Main startup owner must be mutated')
  const changed = original.replace(from, "return topic.id === PMO_TEAMS_TOPIC_ID ? 'on-open' :")
  let red
  try {
    await writeFile(join(isolated, owner), changed)
    red = await run('mandatory-startup-removed', isolated, uiConfig, [startupTest], 4)
    assert.notEqual(red.entry.code, 0, 'Removing mandatory startup must fail')
    const failed = red.result.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed'))
    assert.ok(failed.some(test => test.fullName.includes('mandatory Main continuity')), 'The actual startup consumer must reject the missing recovery')
    assert.match(failed.flatMap(test => test.failureMessages).join('\n'), /AssertionError:/, 'RED must be an owning behavior assertion')
    assert.doesNotMatch(JSON.stringify(red.result.testResults), /Cannot find module|Failed to resolve import|No test files found|Transform failed|SyntaxError:|ReferenceError:/)
    receipt.mutation = { owner, originalSha256: hash(original), mutatedSha256: hash(changed),
      change: 'Remove Main Mote mandatory startup timing while retaining on-open recovery.', red: red.entry }
  } finally { await writeFile(join(isolated, owner), original) }
  green(await run('restored', isolated, uiConfig, [startupTest], 4))
  const nativePath = join(evidence, 'native-continuity.json')
  green(await run('private-native-restart', repository, nativeConfig, [], 1, { MOTE_RECOVERY_NATIVE_RECEIPT: nativePath }))
  const nativeBytes = await readFile(nativePath), native = JSON.parse(nativeBytes)
  assert.equal(native.passed, true); assert.equal(native.runningRuns, 1)
  assert.equal(native.ownerRestarted, true); assert.equal(native.nativeDaemonRestarted, true)
  assert.equal(native.originalTranscriptPrefixRetained, true)
  assert.notEqual(native.originalRun.runId, native.resumedRun.runId)
  receipt.native = { path: relative(repository, nativePath), sha256: hash(nativeBytes), ...native }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.sourceChanges = []
  for (const [file, expected] of Object.entries(receipt.source)) {
    const actual = hash(await readFile(join(repository, file)))
    if (actual !== expected) receipt.sourceChanges.push({ path: file, before: expected, after: actual })
  }
  if (receipt.sourceChanges.length) { receipt.passed = false; receipt.failure = { message: 'Candidate Source changed during verification; this receipt cannot qualify the newer Source.' } }
  await rm(isolated, { recursive: true, force: true })
  receipt.cleanup = { isolatedSourceRemoved: true, productSourceMutated: false, userAppOrRunTouched: false,
    nativeResourceOwner: 'Existing headlessFixture finally disposes exact private clients, owner and Native daemon, then removes its private directory.' }
  const file = join(evidence, 'receipt.json'); await writeFile(file, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(repository, file), runs: receipt.runs.length, failure: receipt.failure?.message }))
  if (!receipt.passed) process.exitCode = 1
}
