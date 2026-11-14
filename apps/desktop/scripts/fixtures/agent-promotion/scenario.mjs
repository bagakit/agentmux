import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import { directoryIdentity, homeZoneId } from '@agentmux/host/mote-model'
import { moteDirectoryName } from '../../../../host/src/mote-directory-identity.mjs'
const [root, mode = 'baseline', helper] = process.argv.slice(2)
const repository = resolve(import.meta.dirname, '../../../../..'), loader = new URL('./source-loader.mjs', import.meta.url)
const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
const sourceArgs = ['--import', 'data:text/javascript,' + encodeURIComponent(registration)]
const scratch = join(root, 'scratch'), project = join(root, 'project')
await mkdir(scratch, { recursive: true }); await mkdir(project, { recursive: true })
const workspace = { id: '__scratch__', hostId: 'local', path: scratch, name: 'Topics', kind: 'folder' }
const configure = enabled => writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], promotion: { enabled } }))
const source = { hostId: 'local', sessionId: 'OriginalSID', displayWorkspaceId: 'project', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const input = { target: { hostId: 'local', agentSessionId: source.sessionId }, source, title: 'Retained collaborator', operationId: 'AcceptedOriginal001' }
const conversation = { ...source, displayWorkspaceId: workspace.id, groupId: 'retained-group', tabId: 'retained-tab', regionId: 'retained-region' }
const topicId = 'launcher:AbCdEfGh1234', directoryPath = join(root, 'motes', moteDirectoryName(topicId)), moteSpaceId = directoryIdentity('local', directoryPath)
// Seed the exact originally published v1 object, with its original address and Main promise.
// No new-admission function is used, and the Host must never rewrite this record.
const record = { version: 1, ...input, workspace, topicId, directoryPath, moteSpaceId, zoneId: homeZoneId(moteSpaceId), conversation,
  session: { hostId: 'local', agentSessionId: source.sessionId, runId: 'original-run', cwd: project, runtimeId: 'original-runtime' } }
const recordPath = join(root, 'agent-promotions', createHash('sha256').update(JSON.stringify(['local', source.sessionId])).digest('hex') + '.json')
const recordBytes = JSON.stringify(record) + '\n'
const graph = { spaces: [{ spaceId: 'project-space', kind: 'folder', name: 'Project', hostId: 'local', directoryPath: project, projectId: 'project' }],
  zones: [{ zoneId: 'project-zone', workspaceId: 'project', hostId: 'local', kind: 'directory', directoryPath: project, branch: null }], bindings: [{ spaceId: 'project-space', zoneId: 'project-zone' }],
  tabs: [{ tabId: source.tabId, workspaceId: 'project', zoneId: 'project-zone', name: null, regionIds: [source.regionId, 'neighbor-region'] }],
  regions: [{ tabId: source.tabId, regionId: source.regionId, kind: 'agent', agentSessionId: source.sessionId, runId: 'original-run', execution: { hostId: 'local', cwd: project, runtimeId: 'original-runtime' } },
    { tabId: source.tabId, regionId: 'neighbor-region', kind: 'agent', agentSessionId: 'NeighborSID', runId: 'neighbor-run', execution: { hostId: 'local', cwd: project, runtimeId: 'original-runtime' } }],
  layouts: { project: { root: { type: 'leaf', groupId: source.groupId }, activeGroupId: source.groupId, groups: [{ id: source.groupId, activeTabId: source.tabId, tabOrder: [source.tabId], recentTabIds: [source.tabId] }] } },
  tabLayouts: { [source.tabId]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: source.regionId }, second: { type: 'leaf', regionId: 'neighbor-region' } }, activeRegionId: source.regionId } },
  resources: { ['region:' + source.regionId]: { workspaceId: 'project', originalDraft: 'Keep the original unsent work', agentPresentation: { sessionId: 'original-ui', agentSessionId: source.sessionId, hostId: 'local' } } } }
await writeFile(join(root, 'spatial.json'), JSON.stringify({ schemaVersion: 1, revision: 1, graph }))
const agent = id => ({ kind: 'agent', agentSessionId: id, providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: project, run: { runId: id === source.sessionId ? 'original-run' : 'neighbor-run' }, createdAt: 1, updatedAt: 1 })
await writeFile(join(root, 'agents.json'), JSON.stringify([agent(source.sessionId), agent('NeighborSID')]))
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(root, 'rpc.sock'), AGENTMUX_WORKSPACE_MOVE_HELPER: helper,
  AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
const worker = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{require('fs').writeFileSync('still-working.txt','original cwd');process.stdout.write('done\\n')})"], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] })
let host, hostStarts = 0
const hostPids = []
async function start() {
  hostStarts++; host = spawn(process.execPath, [...sourceArgs, join(import.meta.dirname, 'host.ts'), root], { env: { ...env, AGENT_PROMOTION_OWNER_ROLE: 'host' }, stdio: ['ignore', 'pipe', 'pipe'] }); hostPids.push(host.pid)
  let out = '', err = ''
  await new Promise((yes, no) => { const timer = setTimeout(() => { host.kill('SIGKILL'); no(Error('Original Host readiness not observed: ' + err)) }, 20000)
    host.once('error', error => { clearTimeout(timer); no(error) }); host.once('exit', code => { clearTimeout(timer); no(Error('Original Host exited: ' + code + ' ' + err)) })
    host.stderr.on('data', value => { err += value }); host.stdout.on('data', value => { out += value; if (out.includes('READY\n')) { clearTimeout(timer); yes() } }) })
}
async function stop() { if (!host || host.exitCode !== null) return; const ended = new Promise(yes => host.once('exit', yes)); host.kill('SIGTERM'); await ended }
async function cli(args, success = true) {
  const child = spawn(process.execPath, [...sourceArgs, join(repository, 'packages/core/src/agentmux.ts'), ...args], { env: { ...env, AGENT_PROMOTION_OWNER_ROLE: 'cli' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  const code = await new Promise((yes, no) => { const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('Private CLI exceeded its observation deadline.')) }, 15000)
    child.stdout.on('data', value => { out += value }); child.stderr.on('data', value => { err += value }); child.once('error', error => { clearTimeout(timer); no(error) }); child.once('exit', value => { clearTimeout(timer); yes(value) }) })
  if (success) { assert.equal(code, 0, err + out); return JSON.parse(out).result }
  assert.notEqual(code, 0, 'The exact operation must be refused'); return JSON.parse(err)
}
async function call(command, value, success = true) { const path = join(root, 'input.json'); await writeFile(path, JSON.stringify(value)); return cli([...command, '--input', path], success) }
const apply = (value = input, success = true) => call(['agent', 'promote', 'apply'], value, success)
const inspect = () => call(['agent', 'promote', 'inspect'], { target: input.target, operationId: input.operationId })
async function assertMain(receipt) {
  assert.equal(receipt.state, 'complete', JSON.stringify(receipt)); assert.equal(receipt.topicId, record.topicId); assert.equal(receipt.directoryPath, record.directoryPath); assert.deepEqual(receipt.conversation, record.conversation)
  const target = { spaceId: record.moteSpaceId, zoneId: record.zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const prefs = await call(['space', 'mote', 'preferences', 'read'], { kind: 'quick', target })
  assert.deepEqual(prefs.defaults.conversation, record.conversation, 'The original accepted Main promise is preserved')
  assert.equal(prefs.defaults.presence.enabled, false, 'The original promotion never enables standing maintenance')
  const after = JSON.parse(await readFile(join(root, 'spatial.json'), 'utf8')).graph
  assert.deepEqual(after.tabs.find(tab => tab.tabId === source.tabId), graph.tabs[0]); assert.deepEqual(after.regions.filter(region => region.tabId === source.tabId), graph.regions)
  assert.deepEqual(after.layouts.project, graph.layouts.project); assert.deepEqual(after.resources['region:' + source.regionId], graph.resources['region:' + source.regionId])
  assert.equal(after.bindings.some(binding => binding.spaceId === record.moteSpaceId && binding.zoneId === 'project-zone'), false, 'A retained operation cannot admit the whole source Zone')
  const tabs = new Set(after.tabs.filter(tab => tab.zoneId === record.zoneId).map(tab => tab.tabId))
  assert.deepEqual(after.regions.filter(region => tabs.has(region.tabId)).map(region => region.agentSessionId), [source.sessionId])
  assert.equal(await readFile(recordPath, 'utf8'), recordBytes, 'No original record rewrite or migration')
}
try {
  await configure(false); await start()
  if (mode === 'baseline') {
    assert.equal((await apply(input, false)).error.code, 'AGENT_PROMOTION_ADMISSION_CLOSED')
    assert.equal((await inspect()).promotion, null)
    await configure(true); assert.equal((await apply(input, false)).error.code, 'AGENT_PROMOTION_ADMISSION_CLOSED'); await configure(false)
    assert.equal((await apply({ ...input, destination: { kind: 'new-club' } }, false)).error.code, 'INVALID_CONTROL_REQUEST', 'Cancelled input has no new alias')
  }
  await stop(); await mkdir(join(root, 'agent-promotions'), { recursive: true }); await durableWriteFile(recordPath, recordBytes, { requireDirectorySync: true }); await start()
  if (mode === 'baseline' || mode === 'personality') {
    await writeFile(join(root, 'fail-personality'), '')
    const partial = (await apply()).promotion; assert.equal(partial.state, 'partial'); assert.equal(partial.stage, 'files')
    await unlink(join(root, 'fail-personality'))
  }
  if (mode === 'baseline') {
    await writeFile(join(root, 'fail-spatial'), '')
    const partial = (await apply()).promotion; assert.equal(partial.state, 'partial'); assert.equal(partial.stage, 'spatial')
    await writeFile(join(record.directoryPath, 'SOUL.md'), '# Authored while pending\nKeep this original content.\n')
    assert.equal((await apply({ ...input, title: 'Changed intent' }, false)).error.code, 'AGENT_PROMOTION_OPERATION_CONFLICT')
    await stop(); await unlink(join(root, 'fail-spatial')); await start()
  }
  if (mode === 'baseline' || mode === 'ack') {
    await writeFile(join(root, 'fail-completion-sync'), '')
    const partial = (await apply()).promotion; assert.equal(partial.state, 'partial'); assert.equal(partial.diskDurability, 'unconfirmed')
    assert.equal((await inspect()).promotion.state, 'partial', 'A visible marker with failed fsync is not a completed operation')
    await stop(); await unlink(join(root, 'fail-completion-sync')); await start()
  }
  const complete = (await apply()).promotion
  await assertMain(complete)
  if (mode === 'baseline') assert.equal(await readFile(join(record.directoryPath, 'SOUL.md'), 'utf8'), '# Authored while pending\nKeep this original content.\n')
  const marker = await readFile(recordPath + '.complete', 'utf8'); assert.equal(marker, input.operationId + '\n')
  if (mode === 'baseline' || mode === 'history') {
    const later = '---\nversion: 1\ndefaults: {}\n---\n# Later authored Main settings\n'
    await writeFile(join(record.directoryPath, 'MOTE.md'), later)
    await stop(); await start()
    assert.equal((await inspect()).promotion.state, 'complete', 'Completed history does not re-evaluate current authored Main')
    const before = await readFile(join(root, 'spatial.json'), 'utf8')
    assert.equal((await apply()).promotion.state, 'complete'); assert.equal(await readFile(join(root, 'spatial.json'), 'utf8'), before)
    assert.equal(await readFile(join(record.directoryPath, 'MOTE.md'), 'utf8'), later, 'A historical operation never replays Main authoring')
  }
  assert.equal(await readFile(recordPath, 'utf8'), recordBytes); assert.equal(await readFile(recordPath + '.complete', 'utf8'), marker)
  assert.equal((await readdir(join(root, 'motes'))).length, 1)
  assert.equal(worker.exitCode, null); const worked = new Promise(yes => worker.stdout.once('data', yes)); worker.stdin.write('continue\n'); await worked
  assert.equal(await readFile(join(project, 'still-working.txt'), 'utf8'), 'original cwd')
  const result = { passed: true, mode, original: input, recordSHA256: createHash('sha256').update(recordBytes).digest('hex'), complete, originalWorkerPid: worker.pid, hostPids, hostRestarts: hostStarts - 1,
    boundary: 'Original v1 accepted bytes, actual source CLI/Unix RPC/Host/Files/spatial/preferences and Host process restart. Metadata for current choices is a controlled leaf; the original cwd worker remains real. No real LLM or installed App claim.' }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log('Accepted promotion: original operation, Main promise, durable completion and healthy work preserved.')
} finally { await stop(); worker.kill('SIGTERM') }
