// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseMoteConnectionParams, parseMoteConnectionOperation, parseMoteConnectionResult } from '@agentmux/core/mote-connections'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useMoteBotSetup } from '../src/renderer/src/lib/use-mote-bot-setup'
import { restoredMoteBotRequests } from '../src/renderer/src/lib/mote-bot-request'
import { useAppStore, retainMoteBotRequest } from '../src/renderer/src/store'
import { imagePng } from './fixtures/mote-identity-image'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() { const f = await moteBotUi({ generic: true }); cleanup.push(f.close); return f }
async function probe(f: Awaited<ReturnType<typeof fixture>>, requireProfile = true) {
  let hook!: ReturnType<typeof useMoteBotSetup>
  const node = document.createElement('div'); document.body.append(node); const view = createClientUiRoot(node)
  function Probe() { hook = useMoteBotSetup(f.target(), f.motes[0]!.id); return null }
  let active = true
  const unmount = async () => { if (active) { active = false; await act(async () => view.unmount()); node.remove() } }
  cleanup.push(unmount)
  await act(async () => view.render(<Probe />))
  if (requireProfile) await vi.waitFor(() => expect(hook.profile).not.toBeNull())
  return { get current() { return hook }, unmount }
}
function row(f: Awaited<ReturnType<typeof fixture>>, operationId: string) { return JSON.parse(String(f.connections.database!.prepare('SELECT record_json FROM mote_connection_operation WHERE operation_id=?').get(operationId)!.record_json)) }
function replaceRow(f: Awaited<ReturnType<typeof fixture>>, operationId: string, saved: unknown) { f.connections.database!.prepare('UPDATE mote_connection_operation SET record_json=? WHERE operation_id=?').run(JSON.stringify(saved), operationId) }
function oldInput(input: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['input']>>) {
  return { operationId: input.operationId, source: { target: input.source.target, expectedTopicRevision: input.source.preparedFrom!.topicRevision, expectedAvatarRevision: input.source.preparedFrom!.avatarRevision }, avatar: 'include-saved', adapterId: input.adapterId, domain: input.domain }
}

it('the real hook and trusted IPC freeze prepared public copy and PNG into the original child, then retire only the confirmed client body', async () => {
  const f = await fixture(), p = await probe(f), profile = p.current.profile!, png = profile.image!
  await act(async () => p.current.begin(p.current.capabilities[0]!, true, 'Prepared public name'))
  const calls = f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.create')
  expect(calls).toHaveLength(1)
  const input = parseMoteConnectionParams('space.mote.connection.create', calls[0]![1])
  expect(input.source).toEqual(profile.source)
  expect(input.desired).toEqual({ name: 'Prepared public name', description: profile.description ?? '', avatar: { pngDataUrl: png } })
  const saved = row(f, input.operationId)
  expect(saved.enrollmentInput.preset).toEqual(input.desired)
  const child = (await f.client.call('connection.enrollment.inspect', { operationId: saved.enrollmentInput.operationId })).operation!
  expect(child).not.toBeNull()
  expect(child.preset?.name).toBe(input.desired.name)
  expect(saved.operation.snapshot.avatarSha256).toBe(createHash('sha256').update(Buffer.from(png.slice(22), 'base64')).digest('hex'))
  expect(saved).not.toHaveProperty('pngDataUrl')
  expect(saved.operation.snapshot.name).toBe('Prepared public name')
  expect(useAppStore.getState().moteBotRequests[input.operationId]).toBeUndefined()
  expect(JSON.stringify(useAppStore.getState().botTaskSelections)).toContain(input.operationId)
  await p.unmount()
  await writeFile(join(f.motes[0]!.directory, 'topic.md'), '# Changed after preparation\n\nDo not replace the original copy.\n')
  f.config.appearance.spaceObjectIcons = {}
  await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  const complete = await confirmAndCreateMote(f, input.operationId)
  expect(complete.snapshot.name).toBe('Prepared public name')
  expect(complete.snapshot.description).toBe(input.desired.description)
  expect(complete.enrollment?.preset?.avatarSha256).toBe(saved.operation.snapshot.avatarSha256)
  expect(row(f, input.operationId).enrollmentInput).toEqual(saved.enrollmentInput)
  expect(f.counts.begin).toBe(1)
})

it('retains a legacy unknown request through actual Store restoration and the hook only inspects its original operation', async () => {
  const f = await fixture(), input = oldInput(await f.input('historical-unknown'))
  const retained = restoredMoteBotRequests({ [input.operationId]: { action: 'create', input, phase: 'may-have-dispatched' } })
  expect(retained[input.operationId]).toEqual({ action: 'create', input, phase: 'may-have-dispatched', inspectOnly: true })
  await retainMoteBotRequest(retained[input.operationId]!)
  useAppStore.setState({ moteBotRequests: restoredMoteBotRequests(JSON.parse(JSON.stringify(useAppStore.getState().moteBotRequests))) })
  const p = await probe(f)
  await act(async () => p.current.check(input.operationId))
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.inspect').map(([, params]) => params)).toContainEqual({ operationId: input.operationId })
  expect(p.current.requests.find(r => r.input.operationId === input.operationId)?.input).toEqual(input)
  await act(async () => p.current.send(p.current.requests.find(r => r.input.operationId === input.operationId)!))
  expect(f.parentCalls.mock.calls.some(([method]) => method === 'space.mote.connection.create' || method === 'space.mote.connection.sync')).toBe(false)
  expect(f.counts.begin).toBe(0)
  expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
  expect(useAppStore.getState().moteBotRequests[input.operationId]?.phase).toBe('may-have-dispatched')
})

it('a lost prepared admission ACK retains its complete body across remount until the same original Host receipt is correlated', async () => {
  const f = await fixture(), p = await probe(f), forward = f.forward
  f.parentCalls.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'space.mote.connection.create') throw new Error('Original prepared reply lost')
    return result
  })
  await act(async () => p.current.begin(p.current.capabilities[0]!, true))
  const input = parseMoteConnectionParams('space.mote.connection.create', f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1])
  expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
  await p.unmount()
  await act(async () => useAppStore.persist.rehydrate())
  vi.spyOn(api.files, 'readPublic').mockRejectedValue(new Error('The client source is now unavailable'))
  const next = await probe(f, false)
  await vi.waitFor(() => expect(next.current.operation?.operationId).toBe(input.operationId))
  expect(useAppStore.getState().moteBotRequests[input.operationId]).toBeUndefined()
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.create')).toHaveLength(1)
  expect(f.counts.begin).toBe(1)
})

it('a local body-retirement persistence failure remains a local saved-view issue after exact Host admission', async () => {
  const f = await fixture(), p = await probe(f), forward = f.forward
  let failing: ReturnType<typeof vi.spyOn> | undefined
  f.parentCalls.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'space.mote.connection.create') failing = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Local selection storage unavailable') })
    return result
  })
  try {
    await act(async () => p.current.begin(p.current.capabilities[0]!, true))
    expect(p.current.operation?.enrollmentOperationId).toBeTruthy()
    expect(p.current.issue).toContain('original Host accepted')
    expect(p.current.issue).toContain('local saved view')
    expect(p.current.issue).not.toContain('This setup is not confirmed')
    expect(f.counts.begin).toBe(1)
  } finally { failing?.mockRestore() }
})

it('continues an exact historical admitted row using its original frozen child without rewriting its old input or manufacturing a lost File ACK', async () => {
  const f = await fixture(), input = await f.input('recorded-history')
  const accepted = await f.client.call('space.mote.connection.create', input), saved = row(f, input.operationId)
  const original = oldInput(input)
  saved.input = original; saved.operation.source = original.source
  replaceRow(f, input.operationId, saved)
  expect(parseMoteConnectionOperation((await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation).source).toEqual(original.source)
  await writeFile(join(f.motes[0]!.directory, 'topic.md'), '# Source changed\n')
  const result = await confirmAndCreateMote(f, input.operationId)
  expect(result.enrollmentOperationId).toBe(accepted.enrollmentOperationId)
  expect(row(f, input.operationId).input).toEqual(original)
  expect(row(f, input.operationId).enrollmentInput).toEqual(saved.enrollmentInput)
  const dispatched = row(f, input.operationId)
  dispatched.defaultPhase = 'dispatching'; dispatched.operation.defaultSave.observedReceipt = null
  replaceRow(f, input.operationId, dispatched)
  const writes = f.writes
  const observed = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(observed.defaultLink.state).toBe('unknown')
  expect(observed.defaultSave?.observedReceipt).toBeNull()
  expect(f.writes).toBe(writes)
})

it('new public writes reject old and mixed contracts, malformed PNG and wrong original resource targets before child effects', async () => {
  const f = await fixture(), input = await f.input('strict-new')
  const invalid = [oldInput(input), { ...input, avatar: 'include-saved' }, { ...input, name: 'Duplicate' }, { ...input, source: { ...input.source, expectedTopicRevision: input.source.preparedFrom!.topicRevision } }, { ...input, desired: { name: 'Missing description', avatar: input.desired.avatar } }, { ...input, desired: { ...input.desired, avatar: { pngDataUrl: 'data:image/png;base64,' + imagePng(128).toString('base64') } } }]
  for (const body of invalid) await expect(f.client.call('space.mote.connection.create', body as never)).rejects.toBeDefined()
  await expect(f.client.call('space.mote.connection.create', { ...input, source: { ...input.source, target: { ...input.source.target, expectedResource: { ...input.source.target.expectedResource, workspacePath: 'foreign-original' } } } })).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  const graph = (await f.spatial.read())!
  await f.spatial.commit({ expectedRevision: graph.revision, graph: { ...graph.graph, bindings: [] } })
  await expect(f.client.call('space.mote.connection.create', input)).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  expect(f.counts.begin).toBe(0)
})

it('explicit prepared provenance may be null and later appearance changes do not prevent a new exact-target admission or omit-avatar sync', async () => {
  const f = await fixture(), input = await f.input('explicit-profile')
  input.source.preparedFrom = null
  input.desired.description = ''
  await writeFile(join(f.motes[0]!.directory, 'topic.md'), '# Later public name\n')
  const accepted = await f.client.call('space.mote.connection.create', input)
  expect(parseMoteConnectionResult('space.mote.connection.create', accepted, input).snapshot.description).toBe('')
  await expect(f.client.call('space.mote.connection.create', { ...input, desired: { ...input.desired, name: 'Different same operation' } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  const created = await confirmAndCreateMote(f, input.operationId), connection = (await f.client.call('connection.inspect', { connectionId: created.connection!.connectionId })).connection!
  const sync = { operationId: 'explicit-sync', source: input.source, desired: { name: 'Prepared sync', description: '' }, connection: created.connection!, expectedConnectionRevision: connection.revision }
  const updated = await f.client.call('space.mote.connection.sync', sync)
  expect(updated.snapshot).toEqual({ name: 'Prepared sync', description: '', avatarSha256: null })
  expect(row(f, sync.operationId).setupInput.goal.desired).not.toHaveProperty('avatar')
})
