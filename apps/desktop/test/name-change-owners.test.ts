import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NameChangeAudit, nameChangeRequests, desktopNameContext, configNameChanges, configNameValue, type NameChangeRecordPort } from '../src/main/name-change-audit.js'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { ConfigOwner } from '../src/main/config-owner.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import { desktopNameHistory } from '../src/main/name-history.js'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { openDemandStore } from '@agentmux/demand'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import type { AppConfig } from '../src/shared/contracts.js'
import type { AgentMuxNameChangeAdmission, AgentMuxNameChangeIntent, AgentMuxNameChangeRecord,
  AgentMuxNameChangeSettlement, AgentMuxNameContext } from '@agentmux/core/control'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, nativeImage: { createFromBuffer: vi.fn() } }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const context: AgentMuxNameContext = { actor: { kind: 'agent', id: 'caller-sid', verified: true },
  source: 'public-rpc', entryPoint: 'settings.executors.update', transport: 'unix', location: { runId: 'caller-run' } }

class Records implements NameChangeRecordPort {
  readonly rows: AgentMuxNameChangeRecord[] = []
  beginFailure = false; settleFailure = false
  async beginNameChange(input: AgentMuxNameChangeIntent): Promise<AgentMuxNameChangeAdmission> {
    if (this.beginFailure) throw new Error('record unavailable')
    const previous = this.rows.find(row => row.id === input.operationId)
    if (previous) return { ...structuredClone(previous), replayed: true }
    const row: AgentMuxNameChangeRecord = { ...structuredClone(input), id: input.operationId, status: 'pending', actual: null,
      startedAt: Date.now(), settledAt: null, reason: null }
    this.rows.push(row); return { ...structuredClone(row), replayed: false }
  }
  async settleNameChange(input: AgentMuxNameChangeSettlement): Promise<AgentMuxNameChangeRecord> {
    if (this.settleFailure) throw new Error('result unavailable')
    const row = this.rows.find(row => row.id === input.id)!
    Object.assign(row, input, { settledAt: Date.now() }); return structuredClone(row)
  }
}
function config(): AppConfig {
  return { executors: { worker: { label: 'Worker' } }, composerShortcuts: [{ id: 'prompt', label: 'Prompt' }],
    hosts: [{ id: 'local', kind: 'local', label: 'Local' }], workspaces: [{ id: 'project', name: 'Project' }],
    toolkit: { tools: [{ id: 'script', name: 'Script', actions: [{ id: 'run', label: 'Run' }] }] } } as unknown as AppConfig
}

describe('names owned by existing Desktop objects', () => {
  it('records the actual serialized Config commit for every existing name field, with the authenticated request context', async () => {
    const records = new Records(); let current = config()
    const owner = new ConfigOwner({ read: () => current, save: async value => structuredClone(value),
      publish: value => { current = value }, nameAudit: new NameChangeAudit(records) })
    await nameChangeRequests.run({ context, operationId: 'rename-six' }, () => owner.update(value => ({
      ...value, executors: { worker: { ...value.executors.worker!, label: 'Renamed Worker' } },
      composerShortcuts: value.composerShortcuts!.map(prompt => ({ ...prompt, label: 'Renamed Prompt' })),
      hosts: value.hosts.map(host => ({ ...host, label: 'Renamed Host' })),
      workspaces: value.workspaces.map(workspace => ({ ...workspace, name: 'Renamed Project' })),
      toolkit: { ...value.toolkit, tools: value.toolkit!.tools!.map(tool => ({ ...tool, name: 'Renamed Script',
        actions: tool.actions!.map(action => ({ ...action, label: 'Renamed Action' })) })) }
    })))
    expect(records.rows.map(row => row.target.kind)).toEqual(['executor', 'prompt', 'host', 'workspace', 'toolkit', 'toolkit-action'])
    expect(records.rows).toHaveLength(6)
    for (const row of records.rows) expect(row).toMatchObject({ status: 'applied', context,
      actual: row.requested, operationId: expect.stringMatching(/^rename-six\/name\/[0-5]$/u) })
    expect(current.executors.worker?.label).toBe('Renamed Worker')
  })
  it('reads editable inline Toolkit names without treating package manifests as Config names', () => {
    const before = config()
    before.toolkit!.tools!.push({ id: 'package', kind: 'package', packagePath: _hygiene_fixturePath("toolkit"), revision: 'one',
      enabled: true, statusBar: 'label', workspacePath: _hygiene_fixturePath("repo"), args: [] })
    const after = structuredClone(before)
    const tool = after.toolkit!.tools!.find(tool => tool.id === 'script')!
    if ('name' in tool) tool.name = 'Chosen script'
    expect(configNameChanges(before, after)).toEqual([{ target: { kind: 'toolkit', id: 'script' },
      before: 'Script', requested: 'Chosen script' }])
    expect(configNameValue(after, { kind: 'toolkit', id: 'script' })).toBe('Chosen script')
    expect(configNameValue(after, { kind: 'toolkit', id: 'package' })).toBeNull()
  })
  it('records explicit unchanged and rejected name intents, and reads actual normalized names from Config', async () => {
    const records = new Records(); let current = config()
    const owner = new ConfigOwner({ read: () => current, save: async value => ({ ...value,
      hosts: value.hosts.map(host => ({ ...host, label: host.label.trim() })) }),
      publish: value => { current = value }, nameAudit: new NameChangeAudit(records) })
    const target = { kind: 'host', id: 'local' }
    await owner.update(value => value, [{ target, requested: 'Local' }])
    expect(records.rows[0]).toMatchObject({ status: 'applied', actual: 'Local', reason: 'unchanged' })
    await expect(owner.update(() => { throw new Error('name conflict') }, [{ target, requested: 'Rejected' }]))
      .rejects.toThrow('name conflict')
    expect(records.rows[1]).toMatchObject({ status: 'failed', actual: 'Local', requested: 'Rejected' })
    await owner.update(value => ({ ...value, hosts: [{ ...value.hosts[0]!, label: '  Actual  ' }] }))
    expect(records.rows[2]).toMatchObject({ status: 'applied', requested: '  Actual  ', actual: 'Actual' })
  })
  it('records unchanged and conflict attempts from the actual Settings resource adapter with its authenticated caller', async () => {
    const records = new Records(); let current = config()
    current.executors.worker = { label: 'Worker', providerId: 'codex', command: 'cat', args: [], env: {}, injectAgentMuxGuide: false }
    const owner = new ConfigOwner({ read: () => current, save: async value => value,
      publish: value => { current = value }, nameAudit: new NameChangeAudit(records) })
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'settings-attempt',
      operation: 'settings.resource.update' as const, resource: 'executors' as const, id: 'worker', changes: { label: 'Worker' } }
    await nameChangeRequests.run({ context, operationId: 'unchanged-resource' }, () => executeSettingsResourcesControl(request, owner))
    expect(records.rows[0]).toMatchObject({ status: 'applied', reason: 'unchanged', context, requested: 'Worker', actual: 'Worker' })
    await expect(nameChangeRequests.run({ context, operationId: 'conflicting-resource' }, () => executeSettingsResourcesControl({
      ...request, changes: { label: 'Rejected' }, expected: { label: 'Wrong previous' }
    }, owner))).rejects.toThrow()
    expect(records.rows[1]).toMatchObject({ status: 'failed', context, requested: 'Rejected', actual: 'Worker' })
  })
  it('keeps the owner name when recording fails before the write', async () => {
    const records = new Records(); records.beginFailure = true
    let current = config(); const save = vi.fn(async (value: AppConfig) => value)
    const owner = new ConfigOwner({ read: () => current, save, publish: value => { current = value }, nameAudit: new NameChangeAudit(records) })
    await expect(owner.update(value => ({ ...value, hosts: [{ ...value.hosts[0]!, label: 'Later' }] }))).rejects.toThrow('record unavailable')
    expect(save).not.toHaveBeenCalled(); expect(current.hosts[0]?.label).toBe('Local')
  })
  it('retains an applied name and the durable pending intent when settlement is unavailable', async () => {
    const records = new Records(); records.settleFailure = true
    let current = config()
    const owner = new ConfigOwner({ read: () => current, save: async value => value,
      publish: value => { current = value }, nameAudit: new NameChangeAudit(records) })
    await expect(owner.update(value => ({ ...value, hosts: [{ ...value.hosts[0]!, label: 'Later' }] })))
      .rejects.toMatchObject({ code: 'NAME_CHANGE_RESULT_UNCONFIRMED', applied: true })
    expect(current.hosts[0]?.label).toBe('Later'); expect(records.rows[0]?.status).toBe('pending')
  })
  it('does not guess a write failure was unapplied, and never invents a caller for an SDK owner', async () => {
    const records = new Records(); const audit = new NameChangeAudit(records)
    await expect(audit.run([{ target: { kind: 'topic', id: 'topic' }, before: 'Before', requested: 'After' }],
      async () => { throw new Error('sync after replace failed') })).rejects.toThrow('sync after replace failed')
    expect(records.rows[0]).toMatchObject({ status: 'unknown', context: { actor: { kind: 'unknown', verified: false } } })
  })
  it('does not replay a previous operation even if the name has returned to its original value', async () => {
    const records = new Records(); const audit = new NameChangeAudit(records); let value = 'Before'
    const apply = vi.fn(async () => { value = 'After' })
    const change = [{ target: { kind: 'host', id: 'local' }, before: 'Before', requested: 'After' }]
    await nameChangeRequests.run({ context, operationId: 'original' }, () => audit.run(change, apply))
    value = 'Before'
    await expect(nameChangeRequests.run({ context, operationId: 'original' }, () => audit.run(change, apply)))
      .rejects.toMatchObject({ code: 'NAME_CHANGE_ALREADY_RECORDED' })
    expect(value).toBe('Before'); expect(apply).toHaveBeenCalledTimes(1)
  })
  it('serializes Topic and Mote title writes and records the true immediately preceding title', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-title-audit-'))); roots.push(root)
    const path = join(root, 'scratch'); await mkdir(path)
    const workspace = { id: 'workspace-scratch', name: 'Scratch', hostId: 'local', path, kind: 'folder' as const }
    // The product's stable scratch workspace ID is independent of a fixture's directory.
    const { SCRATCH_WORKSPACE_ID } = await import('../src/shared/scratch-topics.js'); workspace.id = SCRATCH_WORKSPACE_ID
    const topics = new ScratchTopics(); const records = new Records(); topics.setNameAudit(new NameChangeAudit(records))
    const topic = await topics.ensure(workspace, 'view:audited')
    await Promise.all([topics.renameTitle(workspace, topic.id, 'First'), topics.renameTitle(workspace, topic.id, 'Second')])
    expect(records.rows.map(row => [row.before, row.actual])).toEqual([['Untitled Topic', 'First'], ['First', 'Second']])
    expect((await topics.read(workspace, topic.id))?.title).toBe('Second')
    expect(records.rows.every(row => row.target.id === JSON.stringify([workspace.id, topic.id]))).toBe(true)
    expect(records.rows[0]?.context.location).toMatchObject({ workspaceId: workspace.id, cwd: workspace.path, topicPath: expect.stringContaining('topic.md') })
  })
  it('captures a Browser task name at the draft owner revision without manufacturing a saved-version record', async () => {
    let document: Parameters<BrowserTaskAssetStore['save']>[0] | null = null
    const store: BrowserTaskAssetStore = { load: async () => structuredClone(document), save: async value => { document = structuredClone(value) } }
    const records = new Records(); const assets = new BrowserTaskAssets(store, { nameAudit: new NameChangeAudit(records) })
    const asset = await assets.importRecording({ id: 'recording', browserId: 'browser', navigationId: 'navigation', url: 'https://example.test',
      revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
    await assets.edit(asset.id, asset.revision, { ...asset.draft, name: 'New task' })
    expect(records.rows[0]).toMatchObject({ target: { kind: 'browser-task', id: asset.id }, before: asset.draft.name,
      actual: 'New task', status: 'applied', ownerRevision: asset.revision + 1, context: { location: { browserId: 'browser' } } })
    expect((await assets.state()).assets[0]?.draft.name).toBe('New task')
  })
  it('records a stale Browser task name refusal without changing its name or revision', async () => {
    let document: Parameters<BrowserTaskAssetStore['save']>[0] | null = null
    const save = vi.fn(async (value: Parameters<BrowserTaskAssetStore['save']>[0]) => { document = structuredClone(value) })
    const records = new Records()
    const assets = new BrowserTaskAssets({ load: async () => structuredClone(document), save }, { nameAudit: new NameChangeAudit(records) })
    const asset = await assets.importRecording({ id: 'recording', browserId: 'browser', navigationId: 'navigation', url: 'https://example.test',
      revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
    save.mockClear()
    await expect(nameChangeRequests.run({ context, operationId: 'stale-task-name' }, () =>
      assets.edit(asset.id, asset.revision - 1, { ...asset.draft, name: 'Rejected choice' }))).rejects.toThrow('Task draft changed')
    expect(records.rows).toHaveLength(1)
    expect(records.rows[0]).toMatchObject({ id: 'stale-task-name/name/0', target: { kind: 'browser-task', id: asset.id },
      before: asset.draft.name, requested: 'Rejected choice', actual: asset.draft.name, status: 'failed',
      ownerRevision: asset.revision, context })
    expect((await assets.state()).assets[0]).toMatchObject({ revision: asset.revision, draft: { name: asset.draft.name } })
    expect(save).not.toHaveBeenCalled()
    await expect(assets.edit('missing-task', 0, asset.draft)).rejects.toThrow()
    await expect(assets.edit(asset.id, 0, { ...asset.draft, name: 42 as unknown as string })).rejects.toThrow()
    expect(records.rows).toHaveLength(1)
  })
  it('records a returned file-move error by its actual owner final-location evidence', async () => {
    const records = new Records(); const audit = new NameChangeAudit(records)
    const result = await audit.run([{ target: { kind: 'workspace-path', id: 'project/source' }, before: 'source', requested: 'dest' }],
      async () => ({ status: 'error' as const, finalLocation: 'unknown' as const, message: 'identity changed' }),
      result => ({ actual: null, status: 'unknown', reason: result.message }))
    expect(result.status).toBe('error'); expect(records.rows[0]).toMatchObject({ status: 'unknown', actual: null })
  })
  it('uses the admitted Control identity across the Renderer relay, refuses another target and expires with the request', async () => {
    const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: vi.fn(), sendCancellation: vi.fn() })
    const request = { schemaVersion: 1, requestId: 'control-id', operation: 'demand.update', demandId: 'goal', patch: { title: 'Requested' } } as const
    const result = nameChangeRequests.run({ context, operationId: request.requestId }, () => bridge.execute(request))
    const matches = (value: { operation: string; demandId?: string }) => value.operation === 'demand.update' && value.demandId === 'goal'
    expect(bridge.nameRequest(request.requestId, matches)).toEqual({ context, operationId: request.requestId })
    expect(() => bridge.nameRequest(request.requestId, () => false)).toThrow('does not match')
    bridge.accept({ requestId: request.requestId, ok: true, result: { operation: 'demand.update', demand: {} as never, receipt: { demandId: 'goal', updatedAt: 1 } } })
    await result
    expect(() => bridge.nameRequest(request.requestId, matches)).toThrow('does not match')
  })
  it('queries the actual Spatial and Demand owners in one bounded typed history without losing attribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-host-history-')); roots.push(root)
    const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
    await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {}, tabs: [], regions: [], tabLayouts: {}, resources: {} } })
    const audit = new NameChangeAudit(spatial)
    await nameChangeRequests.run({ context, operationId: 'host-operation' }, () => audit.run([
      { target: { kind: 'host', id: 'saved-host' }, before: 'Old host', requested: 'New host' }
    ], async () => 'New host'))
    const demands = openDemandStore({ root: join(root, 'demands') })
    await demands.create({ id: 'goal', title: 'Old goal' })
    const renamed = await demands.update('goal', { title: 'New goal' }, { context, operationId: 'goal-operation' })
    await demands.delete('goal')
    expect(await demands.get('goal')).toBeNull()
    const first = await desktopNameHistory(spatial, demands, { limit: 1 })
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await desktopNameHistory(spatial, demands, { afterId: first.nextCursor!, limit: 1 })
    expect(first.coverage).toBe('host'); expect(first.records).toHaveLength(1)
    expect(first.diskAcknowledgement).toBe('not-observed')
    expect(second.nextCursor).toBeNull(); expect(second.records).toHaveLength(1)
    const all = [...first.records, ...second.records]
    expect(all.map(record => record.target.kind).sort()).toEqual(['demand', 'host'])
    expect(all.every(record => record.context.actor.id === context.actor.id)).toBe(true)
    const exact = await desktopNameHistory(spatial, demands, { target: { kind: 'demand', id: 'goal' } })
    expect(exact.records).toEqual([renamed.nameChange])
    await expect(desktopNameHistory(spatial, demands, { limit: 101 })).rejects.toThrow('limit')
    await expect(desktopNameHistory(spatial, demands, { afterId: 'missing' })).rejects.toThrow('cursor')
  })
  it('distinguishes a trusted local UI principal from a human claim and an unrelated IPC sender', () => {
    const sender = { id: 3 }; const known = desktopNameContext('config:save', sender, sender, 7)
    expect(known).toMatchObject({ actor: { kind: 'device', verified: true }, entryPoint: 'config:save', location: { webContentsId: '3' } })
    expect(desktopNameContext('config:save', { id: 3 }, sender, 7).actor).toEqual({ kind: 'unknown', id: null, verified: false })
  })
})
