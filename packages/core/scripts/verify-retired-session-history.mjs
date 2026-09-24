import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const worker = process.argv.indexOf('--worker')
if (worker !== -1) {
  const directory = process.argv[worker + 2]
  const compiledIndex = process.argv.indexOf('--compiled-root')
  const compiledRoot = compiledIndex === -1 ? root : process.argv[compiledIndex + 1]
  const { AgentMuxClient, AgentMuxFileAgentSessionStore } = await import(pathToFileURL(join(compiledRoot, 'packages/core/dist/index.js')).href)
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const client = new AgentMuxClient({ store })
  const controls = Object.fromEntries(['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => [name, 0]))
  for (const name of Object.keys(controls)) client.kernel[name] = () => { controls[name]++; throw new Error('Read-only proof attempted a Run control') }
  try {
    if (process.argv[worker + 1] === 'retire') {
      const native = join(directory, 'native.jsonl')
      writeFileSync(native, JSON.stringify({ sessionId: 'native-retained', uuid: 'native-input', type: 'user', message: { role: 'user', content: 'Ordinary-process retained native input' } }) + '\n')
      const session = { kind: 'agent', agentSessionId: 'retained-agent', providerId: 'claude', executorId: 'claude', hostId: 'private-host', workspacePath: directory,
        run: { runId: 'no-live-runtime' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-secret',
        nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-retained', transcriptPath: native } }
      await store.compareAndSwap(null, session)
      await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'captured-input', agentSessionId: session.agentSessionId,
        kind: 'user_message', status: 'complete', source: 'user', createdAt: 100, updatedAt: 100, title: 'Input', content: 'Ordinary-process retained captured input' } })
      const reservation = { kind: 'stop', reservationId: 'private-stop', ownerId: 'private-owner', ownerPid: process.pid, agentSessionId: session.agentSessionId,
        expectedRun: session.run, operationId: 'private-stop-operation', expiresAt: Date.now() + 60_000,
        stopOperation: { daemonInstance: 'private-no-runtime', operationKey: 'private-no-stop', runId: session.run.runId } }
      await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
    }
    const sources = await client.sessionHistorySources()
    const page = await client.sessionHistoryPage('retained-agent')
    const timeline = await client.sessionTimeline('retained-agent')
    assert.deepEqual(sources.map(source => [source.agentSessionId, source.hostId, source.state]), [['retained-agent', 'private-host', 'retired']])
    assert.deepEqual(page.items.map(item => [item.id, item.contentParts]), [['native-input', [{ kind: 'text', text: 'Ordinary-process retained native input' }]]])
    assert.deepEqual(timeline.items.map(item => [item.id, item.content]), [['captured-input', 'Ordinary-process retained captured input']])
    assert.deepEqual(await store.load(), [])
    assert.deepEqual(Object.values(controls), [0, 0, 0, 0, 0, 0])
    process.stdout.write(JSON.stringify({ pid: process.pid, sources, page, timeline, controls }) + '\n')
  } finally { await client.dispose() }
  process.exit(0)
}

const proof = mkdtempSync(join(root, '.tmp/retired-session-history-'))
const copy = join(proof, 'source')
mkdirSync(join(copy, 'packages/core/test/fixtures'), { recursive: true })
cpSync(join(root, 'packages/core/src'), join(copy, 'packages/core/src'), { recursive: true })
cpSync(join(root, 'packages/core/package.json'), join(copy, 'packages/core/package.json'))
for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
  'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts',
  'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json',
  'packages/core/scripts/build.mjs', 'packages/core/scripts/clean-build.mjs']) {
  mkdirSync(dirname(join(copy, file)), { recursive: true })
  cpSync(join(root, file), join(copy, file))
}
symlinkSync(join(root, 'packages/core/node_modules'), join(copy, 'packages/core/node_modules'))
symlinkSync(join(root, 'packages/core/vendor'), join(copy, 'packages/core/vendor'))
// Demand is an immutable input of this Core-only slice and keeps its normal
// source/dist freshness check; this proof never builds or edits that package.
symlinkSync(join(root, 'packages/demand'), join(copy, 'packages/demand'))
symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'))
for (const file of ['retired-session-history.test.ts', 'session-history.test.ts', 'fixtures/native-history-session.ts']) {
  cpSync(join(root, 'packages/core/test', file), join(copy, 'packages/core/test', file))
}
const report = { sourceCandidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  boundary: 'Bound private Core source and normal Core build with unchanged freshness guard; private FileStore transactions and two ordinary Node processes. No complete Main, vendor CLI Writer, GUI retirement, user Runtime or installation claim',
  ordinary: [], tests: [], callers: [], inputs: {}, cleanup: null }
const sourceFiles = ['packages/core/src/agent-session-store.ts', 'packages/core/src/client.ts', 'packages/core/src/types.ts',
  'packages/core/test/retired-session-history.test.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts']
for (const file of sourceFiles) report.inputs[file] = digest(readFileSync(join(root, file)))
function execute(args, expected, logfile, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, AGENTMUX_STATE_DIRECTORY: join(proof, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(proof, 'runtime') } })
  writeFileSync(join(proof, logfile), result.stdout + result.stderr)
  assert.equal(result.status, expected, `${logfile}: ${result.stderr.slice(-1600)}`)
  return result
}
function test(label, red = false, changed = []) {
  const loaded = join(proof, `${label}-loaded.jsonl`)
  const json = join(proof, `${label}-report.json`)
  const config = join(proof, `${label}.config.mts`)
  writeFileSync(config, `import {defineConfig} from 'vitest/config';import base from ${JSON.stringify(join(copy, 'vitest.config.ts'))};import {appendFileSync} from 'node:fs';export default defineConfig({...base,root:${JSON.stringify(copy)},plugins:[{name:'own-loaded-source',transform(_code,id){if(id.startsWith(${JSON.stringify(join(copy, 'packages/core/src'))}))appendFileSync(${JSON.stringify(loaded)},JSON.stringify({id})+'\\n')}}],test:{...base.test,include:['packages/core/test/retired-session-history.test.ts','packages/core/test/session-history.test.ts'],passWithNoTests:false,maxWorkers:1}})`)
  execute([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', json], red ? 1 : 0, `${label}.log`)
  const result = JSON.parse(readFileSync(json, 'utf8'))
  const modules = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line).id)
  assert.ok(result.numTotalTests >= 4 && modules.length > 0, 'The actual owning and loaded source set must be nonempty')
  for (const file of changed) assert.ok(modules.some(id => id === join(copy, file)), `${file} was not actually loaded`)
  if (red) assert.ok(result.testResults.flatMap(item => item.assertionResults).some(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError'))), 'Guard-only or preparation failures cannot qualify a semantic mutation')
  report.tests.push({ label, total: result.numTotalTests, failed: result.numFailedTests, loaded: modules.length, loadedChanged: changed, report: relative(root, json), loadedLog: relative(root, loaded) })
}
const storeFile = 'packages/core/src/agent-session-store.ts'
const original = readFileSync(join(copy, storeFile), 'utf8')
function build(label) {
  // This proof borrows already frozen-lock installed dependencies read-only.
  // pnpm 11 defaults to auto-install before exec; private build must not replace
  // the shared dependency symlink. Source compilation and freshness stay intact.
  const before = process.env.pnpm_config_verify_deps_before_run
  process.env.pnpm_config_verify_deps_before_run = 'false'
  try { execute([join(copy, 'packages/core/scripts/build.mjs')], 0, `${label}-build.log`, join(copy, 'packages/core')) }
  finally {
    if (before === undefined) delete process.env.pnpm_config_verify_deps_before_run
    else process.env.pnpm_config_verify_deps_before_run = before
  }
}
function variant(label, mutate) {
  const changed = mutate(original); assert.notEqual(changed, original)
  writeFileSync(join(copy, storeFile), changed)
  writeFileSync(join(proof, `${label}.source.ts`), changed)
  build(label)
  test(label, true, [storeFile])
  writeFileSync(join(copy, storeFile), original)
  assert.equal(digest(readFileSync(join(copy, storeFile))), digest(Buffer.from(original)))
  build(`${label}-restore`)
  test(`${label}-restore`)
}
try {
  build('baseline')
  const data = join(proof, 'ordinary'); mkdirSync(data)
  for (const phase of ['retire', 'read']) {
    const result = execute([fileURLToPath(import.meta.url), '--worker', phase, data, '--compiled-root', copy], 0, `ordinary-${phase}.log`)
    report.ordinary.push(JSON.parse(result.stdout.trim()))
  }
  assert.notEqual(report.ordinary[0].pid, report.ordinary[1].pid)
  assert.deepEqual(report.ordinary[0].sources, report.ordinary[1].sources)
  assert.deepEqual(report.ordinary[0].page, report.ordinary[1].page)
  assert.deepEqual(report.ordinary[0].timeline, report.ordinary[1].timeline)
  test('baseline')
  variant('missing-locator', source => {
    const token = 'history: sessionHistoryMetadata(previous)'; assert.equal(source.split(token).length - 1, 2)
    return source.replaceAll(token, '...{}')
  })
  variant('orphan-drops-retired', source => {
    const token = '[...sessions, ...retired].map((session) => this.timelinePath(session.agentSessionId))'; assert.equal(source.split(token).length - 1, 1)
    return source.replace(token, 'sessions.map((session) => this.timelinePath(session.agentSessionId))')
  })
  variant('stop-retains-active', source => {
    const start = source.indexOf('const committedSessions = normalizeAgentSessions(sessions)')
    const end = source.indexOf('assertUnboundRetiredRuns(committedSessions, retiredRuns)', start)
    assert.ok(start >= 0 && end > start)
    assert.ok(source.slice(start, end).includes('history: sessionHistoryMetadata(previous)'))
    return source.slice(0, start) + 'const committedSessions = normalizeAgentSessions(previous ? [...sessions, previous] : sessions)\n      const retiredRuns = document.retiredRuns\n      const retiredAgentSessions = document.retiredAgentSessions\n      ' + source.slice(end)
  })
  variant('maintenance-rejects-committed-lifecycle', source => {
    const token = '      process.emitWarning(`Agent Session timeline cleanup failed;'
    assert.equal(source.split(token).length - 1, 1)
    const start = source.indexOf(token)
    const end = source.indexOf('      })', start) + '      })'.length
    assert.ok(start >= 0 && end > start && source.slice(start, end).includes('AGENT_SESSION_TIMELINE_CLEANUP_FAILED'))
    return source.slice(0, start) + '      throw error' + source.slice(end)
  })
  variant('writer-defers-retention-cleanup', source => {
    const token = '}, undefined, true)'; assert.equal(source.split(token).length - 1, 2)
    return source.replaceAll(token, '}, undefined, false)')
  })
  variant('archive-byte-cap-disabled', source => {
    const token = 'Buffer.byteLength(content) > MAX_STORE_BYTES && document.retiredAgentSessions.length > 0'
    assert.equal(source.split(token).length - 1, 1)
    return source.replace(token, 'Buffer.byteLength(content) > MAX_STORE_BYTES && false')
  })
  for (const [symbol, file] of [['loadSessionHistorySources', 'apps/desktop/src/main/runtime-controller.ts'], ['sessionHistorySources', 'apps/desktop/src/main/ipc.ts']]) {
    const text = readFileSync(join(root, file), 'utf8'); assert.ok(text.includes(symbol))
    report.callers.push({ symbol, file, sha256: digest(Buffer.from(text)), excludedDefinition: symbol === 'loadSessionHistorySources' ? storeFile : 'packages/core/src/client.ts' })
  }
  assert.ok(report.callers.length > 0)
  for (const [file, hash] of Object.entries(report.inputs)) assert.equal(digest(readFileSync(join(root, file))), hash, `Source changed during qualification: ${file}`)
  report.passed = true
} catch (error) {
  report.passed = false; report.error = String(error); process.exitCode = 1
} finally {
  writeFileSync(join(proof, 'baseline-store.ts'), original)
  if (existsSync(copy)) rmSync(copy, { recursive: true })
  if (existsSync(join(proof, 'ordinary'))) rmSync(join(proof, 'ordinary'), { recursive: true })
  report.cleanup = { privateSourceRemoved: !existsSync(copy), privateDataRemoved: !existsSync(join(proof, 'ordinary')), sourceAndEvidencePreserved: true, sharedMutations: 0 }
  writeFileSync(join(proof, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, receipt: relative(root, join(proof, 'receipt.json')), error: report.error ?? null }))
}
