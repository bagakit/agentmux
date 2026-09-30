import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [root, compiled, evidence, phase] = process.argv.slice(2)
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href)
const window = new Window({ url: 'http://private.invalid' })
globalThis.window = window; globalThis.document = window.document; globalThis.localStorage = window.localStorage
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
if (phase === 'restore') window.localStorage.setItem('agentmux-workbench-v1', await readFile(join(evidence, 'saved-workbench.json'), 'utf8'))
const { useAppStore, api, createWorkbenchTab, spatialCatalog, directoryIdentity, workspaceZoneId, createWorkspaceLayout, AgentMuxControlServer, parseAgentMuxControlReceipt } = await import(pathToFileURL(join(compiled, 'consumer.mjs')).href)
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }, { id: 'remote', kind: 'ssh', label: 'Resource', hostname: 'private.invalid' }], executors: {},
  workspaces: [{ id: 'resource', hostId: 'remote', name: 'Resource', path: '/resource', kind: 'folder' }, { id: 'display', hostId: 'local', name: 'Display', path: '/display', kind: 'folder' },
    { id: '__scratch__', hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const topics = ['a', 'b'].map(id => ({ id, title: 'Same title', summary: '', directoryPath: `topic--${id}`, topicPath: `topic--${id}/topic.md`, collaborators: [] }))
api.config.get = async () => config; api.providers.list = async () => []; api.demands.list = async () => []
api.scratch.listTopics = async () => topics; api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
api.ui.requestStorageFlush = async () => undefined
const dispose = await useAppStore.getState().initialize(); dispose()
const folder = directoryIdentity('remote', '/resource'), zone = workspaceZoneId(folder, 'resource')
const topicA = directoryIdentity('local', '/topics/topic--a'), topicB = directoryIdentity('local', '/topics/topic--b')
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-compiled-bindings-'))
const server = new AgentMuxControlServer({ execute: request => useAppStore.getState().executeControl(request) }, join(privateRoot, 'control.sock'))
const exec = promisify(execFile)
async function cliOutput(...args) {
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: privateRoot }
  delete env.AGENTMUX_ENV
  const reply = await exec(process.execPath, [join(compiled, 'agentmux.mjs'), ...args], { cwd: root, env, timeout: 15000 })
  return JSON.parse(reply.stdout)
}
async function cli(...args) {
  const receipt = parseAgentMuxControlReceipt(await cliOutput(...args)); assert.equal(receipt.ok, true)
  return receipt
}
const facts = () => spatialCatalog(useAppStore.getState(), topics)
try {
  await server.start()
  if (phase === 'seed') {
    const tab = { ...createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: 'resource', path: 'draft.txt' }), space: { zoneId: zone, spaceId: folder } }
    const first = createWorkspaceLayout('first', [tab.id])
    const layout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5, first: first.root, second: { type: 'leaf', groupId: 'second' } },
      groups: [...first.groups, { ...first.groups[0], id: 'second' }], activeGroupId: 'second' }
    useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { resource: layout, display: createWorkspaceLayout('foreign'), __scratch__: createWorkspaceLayout('scratch-group') }, spaceZoneBindings: {}, activeWorkspaceId: 'resource' })
    assert.equal((await useAppStore.getState().setZoneSpaceRelation(zone, topicA, true)).outcome, 'linked')
    assert.equal((await cli('space', 'bind', '--zone', zone, '--space', topicB)).result.outcome, 'linked')
    const otherProject = directoryIdentity('local', '/display')
    assert.equal((await cli('space', 'bind', '--zone', zone, '--space', otherProject)).result.outcome, 'linked')
    const pmo = await cliOutput('pmo', 'workspaces', '--project', otherProject)
    assert.equal(pmo.operation, 'pmo.workspaces')
    assert.deepEqual(pmo.result.workspaces.map(item => item.workspaceId).sort(), ['display', 'resource'])
    assert.deepEqual(pmo.result.workspaces.find(item => item.workspaceId === 'resource').zones.map(item => item.zoneId), [zone])
    assert.equal((await cli('space', 'unbind', '--zone', zone, '--space', otherProject)).result.outcome, 'unlinked')
    assert.equal((await cli('space', 'bind', '--tab', tab.id, '--display-workspace', 'display', '--group', 'foreign')).result.outcome, 'linked')
    const inspected = await cli('space', 'inspect', '--tab', tab.id, '--display-workspace', 'display', '--group', 'foreign')
    assert.deepEqual(inspected.result.catalog.locations.map(item => [item.displayWorkspaceId, item.groupId, item.spaceId]),
      [['display', 'foreign', folder], ['display', 'foreign', topicA], ['display', 'foreign', topicB]])
    const a = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
    const b = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
    assert.notEqual(a.zone.zoneId, b.zone.zoneId)
    assert.deepEqual([a.zone.workspaceId, b.zone.workspaceId], ['resource', 'resource'])
    assert.equal((await cli('space', 'unbind', '--tab', tab.id, '--display-workspace', 'display', '--group', 'foreign')).result.outcome, 'unlinked')
    assert.ok(useAppStore.getState().tabs[tab.id])
    assert.equal((await cli('space', 'bind', '--tab', tab.id, '--display-workspace', 'display', '--group', 'foreign')).result.outcome, 'linked')
    await writeFile(join(evidence, 'saved-workbench.json'), window.localStorage.getItem('agentmux-workbench-v1'))
    await writeFile(join(evidence, 'expected-compiled-facts.json'), JSON.stringify({ catalog: facts(), layouts: useAppStore.getState().layouts }))
  } else {
    const expected = JSON.parse(await readFile(join(evidence, 'expected-compiled-facts.json'), 'utf8'))
    assert.deepEqual(facts(), expected.catalog)
    assert.deepEqual(useAppStore.getState().layouts, expected.layouts)
    assert.equal(useAppStore.getState().layouts.resource.activeGroupId, 'second')
    assert.equal(useAppStore.getState().layouts.resource.groups.find(group => group.id === 'second').activeTabId, 'original-tab')
    assert.deepEqual(useAppStore.getState().layouts.display.groups[0].tabOrder, ['original-tab'])
    const inspected = await cli('space', 'inspect', '--tab', 'original-tab', '--display-workspace', 'display', '--group', 'foreign')
    assert.equal(inspected.result.catalog.tabs.length, 1)
    assert.equal(inspected.result.catalog.locations.length, 3)
  }
  await writeFile(join(evidence, `compiled-${phase}.json`), JSON.stringify({ passed: true, phase, pid: process.pid, catalog: facts(), layouts: useAppStore.getState().layouts }))
} finally { await server.stop(); await rm(privateRoot, { recursive: true }); await window.happyDOM.abort() }
console.log(JSON.stringify({ passed: true, phase, pid: process.pid }))
