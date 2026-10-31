import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore, connectAgentMuxRpc } from '@agentmux/core'

const [root, hostBundle, cliBundle, helper] = process.argv.slice(2)
const workspace = { id: '__scratch__', hostId: 'local', path: join(root!, 'scratch'), name: 'Topics', kind: 'folder' }
await mkdir(workspace.path, { recursive: true })
await writeFile(join(root!, 'config.json'), JSON.stringify({ workspaces: [workspace] }))
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(root!, 'rpc.sock'), AGENTMUX_WORKSPACE_MOVE_HELPER: helper,
  AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root!, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root!, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root!, 'messages.ndjson') }
const spatial = new AgentMuxSpatialStateStore(join(root!, 'spatial.json'))
let host: ChildProcess | undefined, worker: ChildProcess | undefined, starts = 0, failure: unknown
async function start() {
  host = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', hostBundle!, root!], { env, stdio: ['ignore', 'pipe', 'pipe'] }); starts++
  let stdout = '', stderr = ''
  host.stderr!.on('data', bytes => { stderr += bytes })
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(new Error('Host ready missing: ' + stderr)), 20_000)
    host!.once('error', cause => { clearTimeout(timer); no(cause) })
    host!.once('exit', code => { clearTimeout(timer); no(new Error('Host startup exit ' + code + ': ' + stderr)) })
    host!.stdout!.on('data', bytes => { stdout += bytes; if (stdout.includes('READY\n')) { clearTimeout(timer); yes() } })
  })
}
async function stop(child = host) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>(yes => child.once('exit', () => yes()))
  child.kill('SIGTERM'); await exited
}
async function cli(args: string[], code = 0) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cliBundle!, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const actual = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('exit', yes) })
  assert.equal(actual, code, stderr || stdout)
  return code === 0 ? JSON.parse(stdout).result : JSON.parse(stderr).error
}
async function rpc<M extends import('@agentmux/core').AgentMuxRpcMethod>(method: M, params: import('@agentmux/core').AgentMuxRpcParams<M>) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root!, 'rpc.sock') } })
  try { return await client.call(method, params) } finally { await client.dispose() }
}
try {
  await start()
  const categoryId = 'AbCdEfGh1234', topicId = 'BcDeFgHi2345', entryId = 'CdEfGhJk3456'
  const destination = (await rpc('topic.category.create', { categoryId, title: 'Original' })).category
  const categoryBody = '\n\nKeep original context and references.\n'
  await writeFile(join(destination.directoryPath, 'category.md'), '# Original' + categoryBody)
  for (const title of ['Literal $& title', 'Literal $` title', "Literal $' title", 'Literal $$ title']) {
    const original = (await rpc('topic.category.ls', {})).categories.find(category => category.categoryId === categoryId)!
    assert.ok(original, 'Category discovery must return the original exact object')
    const renamed = await cli(['topic', 'category', 'rename', '--category', categoryId, '--title', title, '--revision', original.revision!])
    assert.equal(renamed.category.title, title, 'literal category title must survive CLI and owner save')
    assert.equal(renamed.category.spaceId, destination.spaceId)
    assert.equal(renamed.category.directoryPath, destination.directoryPath)
    assert.equal(await readFile(join(destination.directoryPath, 'category.md'), 'utf8'), '# ' + title + categoryBody)
    assert.equal((await cli(['topic', 'category', 'rename', '--category', categoryId, '--title', 'stale', '--revision', original.revision!], 1)).code, 'TOPIC_CONTENT_CONFLICT')
  }
  const created = (await cli(['topic', 'create', '--topic', topicId, '--title', 'Original durable Topic'])).topic
  const originalBytes = await readFile(join(created.directoryPath, 'topic.md'))
  await writeFile(join(created.directoryPath, '.agents/codex--OriginalSID.md'), '# Original collaborator\n')
  const knowledge = { topicId, entryId, title: 'Original finding', content: 'retained-topic-mutation-evidence', form: 'derived', certainty: 'fact', sources: [{ kind: 'topic', topicId }], expectedRevision: null }
  const input = join(root!, 'knowledge-input.json'); await writeFile(input, JSON.stringify(knowledge))
  const savedKnowledge = (await cli(['topic', 'knowledge', 'write', '--input', input])).entry
  worker = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{require('fs').writeFileSync('active-cwd.txt','still working');process.stdout.write('done\\n')})"], { cwd: created.directoryPath, stdio: ['pipe', 'pipe', 'pipe'] })
  const livePid = worker.pid
  await stop()
  const current = (await spatial.read())!, graph = structuredClone(current.graph)
  graph.tabs.push({ tabId: 'original-tab', zoneId: created.zoneId, workspaceId: workspace.id, name: 'Original discussion', regionIds: ['original-region'] })
  graph.regions.push({ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'OriginalSID', runId: 'OriginalRun', execution: { hostId: 'local', cwd: created.directoryPath } })
  graph.tabLayouts['original-tab'] = { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' }
  graph.layouts[workspace.id] = { root: { type: 'leaf', groupId: 'original-group' }, groups: [{ id: 'original-group', tabOrder: ['original-tab'], activeTabId: 'original-tab', recentTabIds: ['original-tab'] }], activeGroupId: 'original-group' }
  graph.resources['region:original-region'] = { agentPresentation: { sessionId: 'ui-original', agentSessionId: 'OriginalSID', hostId: 'local' }, originalDraft: 'Unsent original draft' }
  const peerSpaceId = JSON.stringify(['local', join(root!, 'peer-mote')])
  graph.spaces.push({ spaceId: peerSpaceId, kind: 'mote', topicId: 'view:peer', hostId: 'local', directoryPath: join(root!, 'peer-mote'), name: 'Peer Mote', projectId: null })
  graph.bindings.push({ spaceId: peerSpaceId, zoneId: created.zoneId })
  await spatial.commit({ expectedRevision: current.revision, graph })
  await start()
  const beforeMove = (await cli(['topic', 'inspect', '--topic', topicId])).topic
  const moved = await rpc('topic.move', { topicId, categoryId, expectedRevision: beforeMove.spatialRevision })
  assert.deepEqual(moved.topic.categorySpaceIds, [destination.spaceId]); assert.equal(moved.diskDurability, 'confirmed')
  assert.equal(moved.topic.zoneId, created.zoneId); assert.equal(moved.topic.directoryPath, created.directoryPath)
  assert.deepEqual(moved.topic.chatIds, ['original-tab'])
  assert.equal((await cli(['topic', 'move', '--topic', topicId, '--category', categoryId, '--revision', String(beforeMove.spatialRevision)], 1)).code, 'SPATIAL_STATE_CONFLICT')
  const movedState = (await spatial.read())!
  assert.deepEqual(movedState.graph.tabs, graph.tabs); assert.deepEqual(movedState.graph.regions, graph.regions)
  assert.deepEqual(movedState.graph.layouts, graph.layouts); assert.deepEqual(movedState.graph.tabLayouts, graph.tabLayouts)
  assert.deepEqual(movedState.graph.resources['region:original-region'], graph.resources['region:original-region'])
  assert.ok(movedState.graph.bindings.some(binding => binding.spaceId === peerSpaceId && binding.zoneId === created.zoneId), 'Legal foreign Mote binding must remain')

  // Seed the authoritative original Mote identity, as retained after a missing SOUL file.
  // The Zone fact alone must protect it even while its separate Mote Space is unavailable.
  // No replacement Topic or Session is created for the error/recovery scenario.
  await stop()
  const original = (await spatial.read())!, moteGraph = structuredClone(original.graph)
  const origin = moteGraph.resources['zone:' + created.zoneId] as Record<string, import('@agentmux/core/spatial-graph').SpatialJson>
  moteGraph.resources['zone:' + created.zoneId] = { ...origin, contentKind: 'mote' }
  await spatial.commit({ expectedRevision: original.revision, graph: moteGraph })
  await start()
  const retained = (await spatial.read())!, info = (await cli(['topic', 'inspect', '--topic', topicId])).topic
  assert.equal(info.contentKind, 'mote'); assert.equal(info.readError, undefined)
  const failed = await cli(['topic', 'move', '--topic', topicId, '--category', categoryId, '--revision', String(retained.revision)], 1)
  assert.equal(failed.code, 'TOPIC_TARGET_IS_MOTE', 'classification must reject original Core Mote identity')
  assert.match(failed.message, /original|retained/u)
  assert.deepEqual(await spatial.read(), retained, 'Refused classification must leave all original identities and bindings untouched')
  assert.equal((await rpc('topic.knowledge.read', { topicId, entryId })).entry!.content, savedKnowledge.content)
  assert.deepEqual(await readFile(join(created.directoryPath, 'topic.md')), originalBytes)
  await stop(); await start()
  assert.deepEqual(await spatial.read(), retained, 'Original workface must survive a real Host process restart')
  assert.equal((await cli(['topic', 'inspect', '--topic', topicId])).topic.contentKind, 'mote')
  assert.equal(worker.pid, livePid); assert.equal(worker.exitCode, null)
  const working = new Promise<void>(yes => worker!.stdout!.once('data', () => yes()))
  worker.stdin!.write('work\n'); await working
  assert.equal(await readFile(join(created.directoryPath, 'active-cwd.txt'), 'utf8'), 'still working')
  const result = { passed: true, cli: 'compiled candidate CLI -> Core public RPC -> createHostContent -> original Topic owners', hostStarts: starts,
    checks: ['literal category title and content CAS', 'ordinary Topic move with exact Zone/Tab/Region and legal foreign binding', 'stale classification CAS', 'missing SOUL cannot demote original Core Mote', 'rejected write retains knowledge and files', 'real Host process restart retains same workface', 'healthy cwd process remains usable'],
    retained: { zoneId: created.zoneId, tabId: 'original-tab', regionId: 'original-region', agentSessionId: 'OriginalSID', runId: 'OriginalRun', cwd: created.directoryPath, processPid: livePid },
    boundary: 'Original Session/Run facts are fixture spatial references; live cwd process is real. No Agent lifecycle or Provider semantic recovery is exercised.' }
  await writeFile(join(root!, 'result.json'), JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify(result) + '\n')
} catch (cause) { failure = cause }
finally {
  const cleanup = await Promise.allSettled([stop(), worker ? stop(worker) : Promise.resolve()])
  const failures = cleanup.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError([...(failure ? [failure] : []), ...failures.map(result => (result as PromiseRejectedResult).reason)], 'Private fixture cleanup failed')
}
if (failure) throw failure
