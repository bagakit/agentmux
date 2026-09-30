import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/focus-timeline-read-coverage')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-timeline-read-coverage-scene-${Date.now()}`))
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-coverage-'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/focus-time-window.ts', 'apps/desktop/scripts/fixtures/focus-timeline-read-coverage/entry.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-read-coverage/main.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-read-coverage/index.html', 'apps/desktop/scripts/capture-focus-timeline-read-coverage.mjs']
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-timeline-read-coverage-scene.v1', passed: false, candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), inputs: await binding(), actual: { controls: [] }, compiled: {}, images: [], cleanup: null,
  boundary: 'One compiled production Timeline/API/Store presentation with exact raw facts emitted by a private public FileStore/Claude Reader. Renderer transport and current semantic states are typed observations. No Writer, real working-status producer, Runtime, ordinary full App/restart, trackpad or installation qualification.' }
await fs.mkdir(evidence, { recursive: true })
let client
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  const now = Date.now(), HOUR = 3_600_000, store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json'))
  const specs = [
    { id: 'archive-coverage-a', retired: true, records: [{ id: 'a-one', at: now - HOUR, body: 'Keep both closed Contexts visible while reviewing the original message.' }, { id: 'a-two', at: now - HOUR / 2, body: 'Review the previous result before handing the task onward.' }, { id: 'a-unknown', body: 'This original input has no recorded time.' }] },
    { id: 'archive-coverage-b', retired: true, records: [{ id: 'b-one', at: now - HOUR / 3, body: 'The second closed Context is read without deleting the first.' }] },
    { id: 'current-12', retired: false, records: [] }
  ]
  for (const spec of specs) {
    const transcriptPath = path.join(privateRoot, `${spec.id}.jsonl`)
    await fs.writeFile(transcriptPath, spec.records.map(item => JSON.stringify({ sessionId: `native-${spec.id}`, uuid: item.id, type: 'user', message: { role: 'user', content: item.body }, ...(item.at === undefined ? {} : { timestamp: new Date(item.at).toISOString() }) })).join('\n') + '\n')
    const session = { kind: 'agent', agentSessionId: spec.id, providerId: 'claude', executorId: 'private', hostId: 'private-host', workspacePath: privateRoot, run: { runId: `not-controlled-${spec.id}` }, retiredRuns: [], hookBindingId: 'private', hookToken: 'private', createdAt: now - 4 * HOUR, updatedAt: now,
      nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `native-${spec.id}`, transcriptPath } }
    await store.compareAndSwap(null, session)
    if (spec.id === 'archive-coverage-a') await store.applyTimelineMutation({ type: 'append', agentSessionId: spec.id, item: { id: 'captured-a', agentSessionId: spec.id, kind: 'user_message', source: 'user', status: 'complete', createdAt: now - HOUR * 1.5, updatedAt: now - HOUR * 1.5, title: 'Input', content: 'A genuinely captured input remains separate from the native records.' } })
    if (spec.retired) {
      const reservation = { kind: 'stop', reservationId: `retire-${spec.id}`, ownerId: 'private', ownerPid: process.pid, agentSessionId: spec.id, expectedRun: session.run, operationId: `retire-${spec.id}`, expiresAt: now + 60_000, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'not-a-stop', runId: session.run.runId } }
      await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
    }
  }
  client = new AgentMuxClient({ store })
  const descriptors = await client.sessionHistorySources(), sources = []
  assert.equal(descriptors.length, 3)
  for (const spec of specs) {
    const descriptor = descriptors.find(source => source.agentSessionId === spec.id); assert.ok(descriptor)
    sources.push({ ...descriptor, page: await client.sessionHistoryPage(descriptor.agentSessionId, { limit: 30 }), timeline: await client.sessionTimeline(descriptor.agentSessionId) })
  }
  assert.deepEqual(sources[0].page.items.map(item => item.id), ['a-one', 'a-two', 'a-unknown'])
  assert.deepEqual(sources[1].page.items.map(item => item.id), ['b-one'])
  const proof = { schema: 'agentmux.focus-coverage-public-inputs.v1', now, sources, runtimeActions: 0, boundary: 'Real private FileStore/Provider history public methods; retirement commits only private stored facts, no Run/Runtime is started or controlled.' }
  const proofBytes = JSON.stringify(proof, null, 2) + '\n'; await fs.writeFile(path.join(evidence, 'public-inputs.json'), proofBytes)
  receipt.publicInputs = { path: 'public-inputs.json', sha256: hash(proofBytes), sources: descriptors.map(source => [source.agentSessionId, source.state]) }
  const publicProjectorPath = await fs.realpath(fileURLToPath(import.meta.resolve('@agentmux/core/session-user-messages')))
  const loaded = [], binder = { name: 'coverage-actual-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]
    if (file.startsWith(`${root}/apps/desktop/src/`) && /\.[cm]?[jt]sx?$/.test(file)) loaded.push({ path: path.relative(root, file), sha256: hash(code), bytes: Buffer.byteLength(code) })
    if (file === publicProjectorPath) {
      const needle = 'export function projectSessionUserMessages(params) {'; assert.equal(code.split(needle).length, 2)
      const instrumented = code.replace(needle, `${needle}\n globalThis.coverageProjectorCount = (globalThis.coverageProjectorCount ?? 0) + 1;`)
      receipt.projectorCounter = { actualModule: file, sourceSHA256: hash(code), consumedSHA256: hash(instrumented), purpose: 'Count invocations of the exact consumed public projector. No return values or facts are changed.' }
      return { code: instrumented, map: null }
    }
  } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  assert.ok(loaded.some(item => item.path.endsWith('/RecentFocusTimeline.tsx'))); assert.ok(receipt.projectorCounter); receipt.actualLoadedModules = loaded
  await fs.writeFile(path.join(privateRoot, 'renderer/public-inputs.json'), proofBytes)
  await fs.copyFile(path.join(fixture, 'main.mjs'), path.join(privateRoot, 'main.mjs'))
  await fs.mkdir(path.join(privateRoot, 'node_modules'), { recursive: true }); await fs.symlink(path.join(desktop, 'node_modules/electron'), path.join(privateRoot, 'node_modules/electron'))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
  receipt.compiled = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  receipt.compiled['main.mjs'] = hash(await fs.readFile(path.join(privateRoot, 'main.mjs')))
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], result = await runProbeProcess(electron, [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
  await fs.writeFile(path.join(evidence, 'scene.log'), lines.join('\n'))
  const actual = JSON.parse(await fs.readFile(path.join(evidence, 'scene.json'), 'utf8')); receipt.actual = { ...actual, result }
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true); assert.deepEqual(actual.controls, [])
  for (const frame of actual.frames) receipt.images.push({ path: frame.image, width: frame.width, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  assert.deepEqual(await binding(), receipt.inputs); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  if (client) await client.dispose()
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')), images: receipt.images }))
