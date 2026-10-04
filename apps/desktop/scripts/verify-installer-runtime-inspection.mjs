import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
const exec = promisify(execFile), product = resolve(import.meta.dirname, 'package-runtime-upgrade.mjs')
const source = await readFile(product, 'utf8'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'amx-inspection-proof-'))
const configPath = join(root, 'fixture.json'), tracePath = join(root, 'trace.jsonl'), sdkPath = join(root, 'sdk.mjs'), corePath = join(root, 'core.mjs')
const identity = { runtimeId: 'original-runtime', daemonInstanceId: 'original-instance', buildId: 'ctxmuxd/fixture',
  protocolGeneration: 22, runtimeIdPersistence: 'state_dir', capabilities: {} }
const sdk = `import {readFileSync,appendFileSync} from 'node:fs';
export const PROTOCOL_VERSION=22;
export class CtxmuxProtocolError extends Error {constructor(code){super(code);this.code=code}}
const config=()=>JSON.parse(readFileSync(${JSON.stringify(configPath)},'utf8'));
const trace=(method,detail)=>appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({method,...detail})+'\\n');
const wait=ms=>new Promise(done=>setTimeout(done,ms));
export class CtxmuxClient {
 constructor(options){this.options=options;trace('constructor',options)}
 async runtimeInfo(){trace('runtimeInfo',{});const c=config();if(c.runtimeError)throw new Error('identity-read-failed');return c.identity}
 async listPage(cursor){trace('listPage',{cursor});const c=config();if(c.forbidList)throw new Error('UNRELATED_INVENTORY_READ');return cursor===null?{runs:[{id:'original',state:{type:'running'}}],nextCursor:c.repeatCursor?'same':null}:{runs:[],nextCursor:'same'}}
 async status(id){trace('status',{id});const c=config();if(c.delayMs)await wait(c.delayMs);if(id==='missing')throw new CtxmuxProtocolError('run_not_found');if(c.statusError)throw new CtxmuxProtocolError(c.statusError);return {id:c.wrongRun?'foreign-run':id,pid:71,backend:'pty',state:{type:id==='ended'?'exited':'running'},applied_input_bytes:17,latest_output_bytes:29,current_size:{rows:24,cols:80}}}
}
`
await writeFile(sdkPath, sdk)
await writeFile(corePath, "export function assertAgentMuxRuntimeCompatibility(runtime){if(runtime.protocolGeneration!==22)throw new Error('INCOMPATIBLE_RUNTIME')}")
async function configure(extra = {}) { await writeFile(configPath, JSON.stringify({ identity, forbidList: true, ...extra })); await writeFile(tracePath, '') }
async function calls() { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
async function cli(helper, ids, extra = {}) {
  await configure(extra)
  try { const result = await exec(process.execPath, [helper, '--inspect', sdkPath, join(root, 'socket'), corePath,
    ...(ids === undefined ? [] : [JSON.stringify(ids)])], { maxBuffer: 1024 * 1024 })
    return { status: 'ok', value: JSON.parse(result.stdout), calls: await calls() }
  } catch (error) { return { status: 'error', message: error.stderr, calls: await calls() } }
}
async function fast(helper) {
  const scoped = await cli(helper, ['original', 'ended', 'missing', 'original'])
  assert.equal(scoped.status, 'ok', 'scoped original references remain readable without a fleet scan')
  assert.deepEqual(scoped.value.running.map(run => run.id), ['original'])
  assert.deepEqual(scoped.calls.filter(call => call.method === 'status').map(call => call.id), ['original', 'ended', 'missing'])
  assert.equal(scoped.calls.filter(call => call.method === 'listPage').length, 0, 'exact scope must not read unrelated inventory')
  assert(scoped.calls.some(call => call.expectedRuntimeIdentity?.daemonInstanceId === identity.daemonInstanceId))
  const empty = await cli(helper, [])
  assert.equal(empty.status, 'ok'); assert.equal(empty.calls.filter(call => call.method === 'runtimeInfo').length, 1)
  const incompatible = await cli(helper, [], { identity: { ...identity, protocolGeneration: 21 } })
  assert.equal(incompatible.status, 'error'); assert.match(incompatible.message, /compatibility/)
  assert.match(incompatible.message, /INCOMPATIBLE_RUNTIME/)
  const wrong = await cli(helper, ['original'], { wrongRun: true })
  assert.equal(wrong.status, 'error', 'a foreign Run result must reject the observation')
  assert.match(wrong.message, /status identity/); assert.match(wrong.message, /original/)
  const unknown = await cli(helper, ['original'], { statusError: 'io' })
  assert.equal(unknown.status, 'error', 'only authoritative run_not_found may skip a retained reference')
  assert.match(unknown.message, /"stage":"status"/); assert.match(unknown.message, /"runId":"original"/)
  assert.match(unknown.message, /elapsedMs/); assert.match(unknown.message, /observation is unconfirmed|inspection is unconfirmed/)
  const full = await cli(helper, undefined, { forbidList: false })
  assert.equal(full.status, 'ok'); assert(full.calls.some(call => call.method === 'listPage'))
  const cursor = await cli(helper, undefined, { forbidList: false, repeatCursor: true })
  assert.equal(cursor.status, 'error'); assert.match(cursor.message, /inventory cursor/)
}
const generated = []
let server
const results = []
try {
  await fast(product)
  results.push({ name: 'public helper exact scope, empty identity, compatibility, wrong Run, unknown, full inventory and cursor', pass: true })
  // The production installer must consume these helpers, not a test-only API.
  const callerPath = resolve(import.meta.dirname, 'package-macos.mjs'), caller = await readFile(callerPath, 'utf8')
  assert.match(caller, /await prepareUiRuntime\(previouslyInstalled \? currentPath : null, next, before\)/)
  assert.match(caller, /assertUiRuntimeObservation\(observed, await confirmUiRuntime\(runtimePlan\), before\)/)
  const { prepareUiRuntime, confirmUiRuntime, closeRuntimeUpgrade } = await import(pathToFileURL(product).href)
  const app = join(root, 'private.app'), core = join(app, 'Contents/Resources/app/node_modules/@agentmux/core')
  const vendor = join(core, 'vendor/ctxmux', process.platform + '-' + process.arch)
  await mkdir(join(vendor, 'bin'), { recursive: true }); await mkdir(join(core, 'dist'), { recursive: true })
  await copyFile('/usr/bin/true', join(vendor, 'bin/ctxmuxd'))
  const packageDir = join(root, 'sdk-package/package'); await mkdir(join(packageDir, 'dist'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), '{"type":"module"}')
  await writeFile(join(packageDir, 'dist/index.js'), sdk)
  const archivePath = join(vendor, 'sdk.tgz')
  await exec('/usr/bin/tar', ['-czf', archivePath, '-C', dirname(packageDir), 'package'])
  await writeFile(join(core, 'package.json'), '{"type":"module"}')
  await writeFile(join(core, 'dist/index.js'), await readFile(corePath))
  const socket = join(root, 'private.sock')
  await writeFile(join(core, 'dist/runtime-paths.js'), `export const defaultCtxmuxSocketPath=()=>${JSON.stringify(socket)};export const defaultCtxmuxStateDirectory=()=>${JSON.stringify(join(root, 'state'))};`)
  await writeFile(join(vendor, 'manifest.json'), JSON.stringify({ schema: 'ctxmux.local-artifacts.v1',
    support: { platform: process.platform, architecture: process.arch }, binaries: [{ name: 'ctxmuxd', path: 'bin/ctxmuxd', sha256: sha(await readFile(join(vendor, 'bin/ctxmuxd'))) }],
    sdk: { archive: { path: 'sdk.tgz', sha256: sha(await readFile(archivePath)) } } }))
  server = createServer(connection => connection.destroy())
  await new Promise((done, reject) => { server.once('error', reject); server.listen(socket, done) })
  const focus = { executionSessionId: null, pmoSessionId: null }
  const regions = Array.from({ length: 40 }, (_, i) => ({ regionId: 'region-' + i, workspaceId: 'workspace', sessionId: 'agent-' + i,
    kind: 'agent', phase: 'attached', processState: 'running', control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-' + i, run: { runId: 'run-' + i } } }))
  const observation = { schema: 'agentmux.desktop-client-observation.v1', main: { pid: 1, package: null,
    renderer: { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'shell', ctxmux: 'ctxmux' } },
    runtimes: [{ hostId: 'local', identity: { hostId: 'local', buildIdentity: identity.buildId, protocolVersion: 22, processId: null, instanceId: identity.daemonInstanceId } }] },
    workbench: { loading: false, startupProgress: { step: 'layout' }, activeWorkspaceId: 'workspace', mainSurface: 'workbench', focus,
      desktop: { selection: { surface: 'space', mainSurface: 'workbench', space: null, goalId: null },
        presentation: { provenance: 'unknown', state: 'unknown', tabId: null, regionId: null, blockers: [] },
        input: { provenance: 'unknown', scope: 'unknown', ownerKind: null, tabId: null, regionId: null, sessionId: null, connected: null, visible: null, inert: null },
        floating: { provenance: 'unknown', state: 'unknown', topicId: null, tabId: null, regionId: null, sessionId: null, presentation: 'unknown' },
        overlays: { provenance: 'unknown', settings: null, quickSwitcher: null }, focus },
      tabs: regions.map((region, i) => ({ id: 'tab-' + i, workspaceId: 'workspace', titleRegionId: region.regionId,
        layout: { root: { type: 'leaf', regionId: region.regionId }, activeRegionId: region.regionId }, regions: [region] })), layouts: {} } }
  await configure({ delayMs: 260 })
  const started = Date.now(); const plan = await prepareUiRuntime(app, app, observation)
  try {
    assert(plan); assert.equal(plan.before.running.length, 40); assert(Date.now() - started > 10_000, 'actual healthy aggregate observation exceeds the removed ten-second deadline')
    await configure()
    const confirmation = await confirmUiRuntime(plan)
    assert.equal(confirmation.originalRuns.length, 40)
    assert((await calls()).some(call => call.expectedRuntimeIdentity?.daemonInstanceId === identity.daemonInstanceId),
      'original Run confirmation is fenced to the identity confirmed before status reads')
    await configure({ wrongRun: true })
    await assert.rejects(confirmUiRuntime(plan), /status identity/, 'original Run confirmation rejects wrong identity')
  } finally { await closeRuntimeUpgrade(plan) }
  results.push({ name: 'real prepareUiRuntime and confirmUiRuntime over 40 scoped references and old ten-second boundary', pass: true, elapsedMs: Date.now() - started, callerPath, callerSha256: sha(caller) })
  const mutations = [
    { name: 'scan-unrelated-inventory', before: 'if (runIds !== undefined) {', after: 'if (false) {', oracle: 'scoped original references remain readable without a fleet scan' },
    { name: 'accept-foreign-run', before: "fail(run.id === id, 'The Runtime returned another Run instead of the requested identity.')", after: "fail(true, 'The Runtime returned another Run instead of the requested identity.')", oracle: 'a foreign Run result must reject the observation' },
    { name: 'skip-unknown-status', before: "error.code === 'run_not_found'", after: 'true', oracle: 'only authoritative run_not_found may skip a retained reference' }
  ]
  for (const mutation of mutations) {
    assert(source.includes(mutation.before), 'mutation must target loaded production code')
    const path = join(dirname(product), '.inspection-mutant-' + randomUUID() + '.mjs'); generated.push(path)
    const changed = source.replaceAll(mutation.before, mutation.after); await writeFile(path, changed)
    let assertion
    await assert.rejects(fast(path), error => {
      assert(error instanceof assert.AssertionError); assert(error.message.includes(mutation.oracle)); assertion = error.message; return true
    }, 'each loaded product mutant must kill its owning assertion')
    await rm(path); generated.splice(generated.indexOf(path), 1)
    await fast(product)
    results.push({ mutation: mutation.name, loadedSourceSha256: sha(changed), red: true, assertion, restoredGreen: true })
  }
  // Exercise the request wait itself without waiting thirty real seconds. Only
  // this disposable loaded copy scales the timer; the product remains 30s.
  const path = join(dirname(product), '.inspection-wait-' + randomUUID() + '.mjs'); generated.push(path)
  await writeFile(path, source.replace('OBSERVATION_REQUEST_WAIT_MS = 30_000', 'OBSERVATION_REQUEST_WAIT_MS = 25'))
  const timed = await cli(path, ['original'], { delayMs: 100 })
  assert.equal(timed.status, 'error'); assert.match(timed.message, /"requestWaitMs":25/); assert.match(timed.message, /"stage":"status"/)
  await rm(path); generated.splice(generated.indexOf(path), 1)
  const receipt = { status: 'pass', sourceSha256: sha(source), verifierSha256: sha(await readFile(import.meta.filename)), publicSdkFixtureSha256: sha(sdk), results, requestWait: 'per-RPC 30s; scaled loaded branch proved unknown', userRuntimeQueried: false }
  const receiptPath = process.env.AGENTMUX_INSPECTION_PROOF_RECEIPT
  if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} finally {
  if (server) await new Promise(done => server.close(done))
  for (const path of generated) await rm(path, { force: true })
  await rm(root, { recursive: true, force: true })
}
