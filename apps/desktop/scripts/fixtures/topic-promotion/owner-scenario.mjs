import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.argv[2], hostBundle = process.argv[3], cliBundle = process.argv[4], helper = process.argv[5]
await mkdir(root, { recursive: true })
const scratch = join(root, 'scratch'); await mkdir(scratch, { recursive: true })
const workspace = { id: '__scratch__', hostId: 'local', path: scratch, name: 'Topics', kind: 'folder' }
await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace] }))
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(root, 'rpc.sock'), AGENTMUX_WORKSPACE_MOVE_HELPER: helper,
  AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
let host, cwdWorker
async function start() {
  host = spawn(process.execPath, [hostBundle, root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  host.stderr.on('data', bytes => { error += bytes })
  await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('Host ready missing: ' + error)), 20000)
    host.once('exit', code => { clearTimeout(timer); no(new Error('Host startup exit ' + code + ': ' + error)) })
    host.stdout.on('data', bytes => { output += bytes; if (output.includes('READY\n')) { clearTimeout(timer); yes() } })
  })
}
async function stop() { if (!host || host.exitCode !== null) return; const exited = new Promise(yes => host.once('exit', yes)); host.kill('SIGTERM'); await exited }
async function cli(args, valid = true) {
  const child = spawn(process.execPath, [cliBundle, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { error += b })
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
  if (valid) { assert.equal(code, 0, error); return JSON.parse(output).result }
  assert.notEqual(code, 0); return JSON.parse(error)
}
try {
  await start()
  const topicId = 'view:promotion-source', operationId = 'AbCdEfGh1234', entryId = 'BcDeFgHi2345'
  const created = (await cli(['topic', 'create', '--topic', topicId, '--title', '示例项目 数据运维'])).topic
  const original = created.directoryPath, originalStat = await stat(original), originalBytes = await readFile(join(original, 'topic.md'))
  const wikiBytes = await readFile(join(original, '.agentmux/topic-wiki.md'))
  await writeFile(join(original, '.agents/codex--OriginalSID.md'), '# Original Agent\nKeep this member identity.\n')
  const knowledge = { topicId, entryId, title: 'Original finding', content: 'retained-diagnostic-knowledge', form: 'derived', certainty: 'fact', sources: [{ kind: 'topic', topicId }], expectedRevision: null }
  const input = join(root, 'knowledge-input.json'); await writeFile(input, JSON.stringify(knowledge))
  const written = (await cli(['topic', 'knowledge', 'write', '--input', input])).entry
  const before = JSON.parse(await readFile(join(root, 'spatial.json'), 'utf8'))
  const graph = before.graph, zoneId = created.zoneId
  graph.tabs.push({ tabId: 'original-tab', zoneId, workspaceId: workspace.id, name: 'Original discussion', regionIds: ['original-region'] })
  graph.regions.push({ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'OriginalSID', runId: 'OriginalRun', execution: { hostId: 'local', cwd: original } })
  graph.tabLayouts['original-tab'] = { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' }
  graph.layouts[workspace.id] = { root: { type: 'leaf', groupId: 'original-group' }, groups: [{ id: 'original-group', tabOrder: ['original-tab'], activeTabId: 'original-tab', recentTabIds: ['original-tab'] }], activeGroupId: 'original-group' }
  graph.resources['region:original-region'] = { agentPresentation: { sessionId: 'ui-original', agentSessionId: 'OriginalSID', hostId: 'local' }, originalDraft: 'keep draft' }
  await stop()
  await writeFile(join(root, 'spatial.json'), JSON.stringify({ ...before, graph }))
  await start()
  cwdWorker = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{require('fs').writeFileSync('active-cwd.txt','still working');process.stdout.write('done\\n')})"], { cwd: original, stdio: ['pipe', 'pipe', 'pipe'] })
  const livePid = cwdWorker.pid
  await writeFile(join(root, 'fail-spatial'), '')
  const partial = (await cli(['topic', 'promote', 'apply', '--topic', topicId, '--operation-id', operationId])).promotion
  assert.equal(partial.state, 'partial'); assert.equal(partial.stage, 'spatial')
  assert.equal(partial.operationId, operationId)
  const during = await cli(['topic', 'knowledge', 'search', '--query', 'retained-diagnostic-knowledge'])
  assert(during.entries.some(entry => entry.topicId === topicId), 'Partial promotion must retain original global knowledge access')
  const moved = await realpath(original); assert.notEqual(moved, original)
  const movedStat = await stat(moved); assert.equal(movedStat.ino, originalStat.ino); assert.equal(movedStat.dev, originalStat.dev)
  assert.deepEqual(await readFile(join(moved, 'topic.md')), originalBytes)
  assert.deepEqual(await readFile(join(moved, '.agentmux/topic-wiki.md')), wikiBytes)
  await writeFile(join(moved, 'SOUL.md'), '# Later authored personality\nKeep my words.\n')
  const existingOperation = (await cli(['topic', 'promote', 'inspect', '--topic', topicId])).promotion
  assert.equal(existingOperation.operationId, operationId); assert.equal(existingOperation.state, 'partial')
  const rejected = await cli(['topic', 'promote', 'apply', '--topic', topicId, '--operation-id', 'CdEfGhJk3456'], false)
  assert.equal(rejected.error.code, 'TOPIC_PROMOTION_OPERATION_CONFLICT')
  await stop(); await unlink(join(root, 'fail-spatial')); await start()
  const resumed = (await cli(['topic', 'promote', 'apply', '--topic', topicId, '--operation-id', operationId])).promotion
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.diskDurability, 'confirmed')
  assert.equal(resumed.topic.zoneId, zoneId); assert.deepEqual(resumed.topic.chatIds, ['original-tab']); assert.equal(resumed.topic.contentKind, 'mote')
  assert.equal(await readFile(join(moved, 'SOUL.md'), 'utf8'), '# Later authored personality\nKeep my words.\n')
  assert.equal((await cli(['topic', 'knowledge', 'read', '--topic', topicId, '--entry', entryId])).entry.content, written.content)
  knowledge.content = 'retained-diagnostic-knowledge plus after promotion'; knowledge.expectedRevision = written.revision
  await writeFile(input, JSON.stringify(knowledge)); await cli(['topic', 'knowledge', 'write', '--input', input])
  const search = await cli(['topic', 'knowledge', 'search', '--query', 'retained-diagnostic-knowledge'])
  assert(search.entries.some(entry => entry.topicId === topicId && entry.content.includes('plus after')))
  const topics = (await cli(['topic', 'ls'])).topics
  assert(topics.some(topic => topic.topicId === topicId && topic.contentKind === 'mote'))
  const after = JSON.parse(await readFile(join(root, 'spatial.json'), 'utf8'))
  assert.deepEqual(after.graph.tabs, graph.tabs); assert.deepEqual(after.graph.regions, graph.regions)
  assert.deepEqual(after.graph.layouts, graph.layouts); assert.deepEqual(after.graph.tabLayouts, graph.tabLayouts)
  assert.deepEqual(after.graph.resources['region:original-region'], graph.resources['region:original-region'])
  for (const binding of graph.bindings) assert(after.graph.bindings.some(item => item.zoneId === binding.zoneId && item.spaceId === binding.spaceId))
  assert(after.graph.bindings.some(item => item.zoneId === zoneId && item.spaceId === resumed.moteSpaceId))
  const originalRevision = after.revision
  await cli(['topic', 'promote', 'apply', '--topic', topicId, '--operation-id', operationId])
  assert.equal(JSON.parse(await readFile(join(root, 'spatial.json'), 'utf8')).revision, originalRevision)
  await stop(); await start()
  assert.equal((await cli(['topic', 'promote', 'inspect', '--topic', topicId, '--operation-id', operationId])).promotion.state, 'complete')
  assert.equal(cwdWorker.pid, livePid); assert.equal(cwdWorker.exitCode, null)
  const working = new Promise(yes => cwdWorker.stdout.once('data', yes)); cwdWorker.stdin.write('work\n'); await working
  assert.equal(await readFile(join(moved, 'active-cwd.txt'), 'utf8'), 'still working')
  assert.equal(await readFile(join(moved, '.agents/codex--OriginalSID.md'), 'utf8'), '# Original Agent\nKeep this member identity.\n')
  const result = { passed: true, cli: 'actual compiled CLI to Core public service and createHostContent owner', restart: { hostRestarts: 3, retainedZone: zoneId, retainedTab: 'original-tab', retainedRegion: 'original-region', retainedSession: 'OriginalSID', retainedRun: 'OriginalRun', activeCwdProcessPid: livePid, inode: String(originalStat.ino), providerSemanticResume: 'not exercised; promotion does not invoke agent lifecycle' }, checks: ['partial receipt and original operation discovery', 'different-operation conflict', 'same-operation explicit continuation', 'authored persona preserved', 'knowledge read/write/search after promotion', 'original category entry and Mote binding', 'idempotence', 'durable original workface after process restart', 'healthy original cwd process retained'] }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result) + '\n')
} finally { await stop(); cwdWorker?.kill('SIGTERM') }
