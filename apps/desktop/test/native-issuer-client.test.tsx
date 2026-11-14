// @vitest-environment happy-dom
import { act } from 'react'
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { moteConnectionJourney } from './fixtures/mote-connection-journey'
import { MoteConnectionPanel } from '../src/renderer/src/components/MoteConnectionIdentity'
import { botTaskSelectionKey, retainedIdentityRemovalTasks, restoredIdentityRemovalTask, restoredManagementTask } from '../src/renderer/src/lib/bot-task-selection'
import { connectorMemberKey, editConnectorMemberDraft, restoredConnectorMemberDrafts } from '../src/renderer/src/lib/connector-member-draft'
import { applicationMemberKey, restoredApplicationAccess } from '../src/renderer/src/lib/application-member-intent'
import { ConnectionIdentityRemoval } from '../src/renderer/src/components/settings/ConnectionIdentityRemoval'
import { useAppStore } from '../src/renderer/src/store'
import { ConnectorMemberAccess } from '../src/renderer/src/components/ConnectorMemberAccess'
import { createSpeakerResolver, speakerOfExternalAuthor } from '@agentmux/client-ui/conversation-speaker'
import { createClientUiRoot } from './helpers/client-ui-render'

const a = { domain: 'feishu.cn', appId: 'app-a', issuer: 'https://first.example' }
const b = { ...a, issuer: 'https://second.example' }
const owner = { hostId: 'local', runtimeId: 'fixture-runtime' }
const actor = (application: typeof a) => ({ application, idType: 'open_id', userId: 'same-user' })
let f: Awaited<ReturnType<typeof moteConnectionJourney>> | undefined
beforeEach(() => { f = undefined })
afterEach(async () => { await f?.dispose() })

it('keeps an invalid original issuer unconfirmed through the public Mote file reader without rewriting it', async () => {
  f = await moteConnectionJourney()
  const document = (issuer: string) => '---\nversion: 1\ndefaults:\n  connection:\n    connectionId: robot-scoped\n    application:\n      domain: feishu.cn\n      appId: app-a\n      issuer: ' + issuer + '\n---\n# Original notes\n'
  for (const issuer of ['{ host: https://first.example }', '[https://first.example]']) {
    const original = document(issuer)
    await writeFile(f.path(), original)
    const observed = await f.read()
    expect(observed.status).toBe('unconfirmed')
    expect(observed.values).toBeNull()
    expect(observed.source?.result.status).toBe('read')
    expect(await f.bytes()).toBe(original)
    expect(f.saves).not.toHaveBeenCalled()
  }
  await writeFile(f.path(), document(a.issuer))
  expect((await f.read()).values?.connection).toEqual({ connectionId: 'robot-scoped', application: a })
})

it('reads the original Mote file and refuses an issuer replacement in its actual default-bot UI, then restores the original source', async () => {
  f = await moteConnectionJourney()
  const ref = { connectionId: 'robot-scoped', application: a }
  await f.services.connections.configure({ operationId: 'seed-scoped', expectedRevision: null, connection: { connectionId: ref.connectionId, adapterId: 'feishu', application: a, label: 'Scoped Robot', enabled: true, credentialRef: 'unused-scoped' } })
  const before = await f.read()
  expect(moteConnectionBaseline(before), JSON.stringify(before)).not.toBeNull()
  const saved = await f.client.call('space.mote.preferences.save', { kind: 'connection', operationId: 'seed-pref', target: f.target(), baseline: moteConnectionBaseline(before)!, values: { connection: ref } })
  expect(saved.status, JSON.stringify(saved)).toBe('saved')
  expect((await f.read()).values?.connection).toEqual(ref)
  const originalCall = f.connections.getMockImplementation()!
  let current = b
  f.connections.mockImplementation(async (method, input, target) => {
    const result = await originalCall(method, input, target)
    if (method !== 'connection.ls') return result
    return { ...result, connections: result.connections.map((record: any) => record.config.connectionId === ref.connectionId
      ? { ...record, config: { ...record.config, application: current } } : record) } as typeof result
  })
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
  const onRead = vi.fn()
  const panel = (key: string) => <MoteConnectionPanel key={key} target={f!.target()} hostingTarget={owner} topicId={f!.motes[0]!.id} moteName="Original Mote" onRead={onRead} />
  try {
    await act(async () => root.render(panel('wrong-issuer')))
    await vi.waitFor(async () => { await act(async () => {}); expect(node.querySelector('[aria-label="Saved bot needs attention"]')?.textContent).toContain('different bot') })
    expect(f.saves).not.toHaveBeenCalled()
    expect((await f.read()).values?.connection).toEqual(ref)
    current = a
    await act(async () => root.render(panel('original-issuer')))
    await vi.waitFor(async () => { await act(async () => {}); expect(onRead).toHaveBeenCalledTimes(2) })
    expect(node.querySelector('[aria-label="Saved bot needs attention"]')).toBeNull()
    expect(node.textContent).toContain('Scoped Robot')
    expect(f.saves).not.toHaveBeenCalled()
    expect((await f.read()).values?.connection).toEqual(ref)
  } finally { await act(async () => root.unmount()); node.remove() }
})

it('isolates retained scoped operation locators and preserves unscoped originals without inventing an issuer', () => {
  const base = { kind: 'identity-removal' as const, connectionId: 'robot-a', adapterId: 'native', domain: a.domain, appId: a.appId, expectedRevision: 1, hostingTarget: owner }
  const oldKey = botTaskSelectionKey(base), scopedKey = botTaskSelectionKey({ ...base, issuer: a.issuer })
  const saved = { [oldKey]: { operationId: 'old-unknown', hostingTarget: owner }, [scopedKey]: { operationId: 'a-unknown', hostingTarget: owner } }
  expect(retainedIdentityRemovalTasks(saved).map(item => item.operationId).sort()).toEqual(['a-unknown', 'old-unknown'])
  const record = (application: typeof a | Omit<typeof a, 'issuer'>) => ({ config: { connectionId: 'robot-a', adapterId: 'native', application } })
  expect(restoredIdentityRemovalTask(record(a), saved, owner)?.operationId).toBe('a-unknown')
  expect(restoredIdentityRemovalTask(record(b), saved, owner)).toBeNull()
  expect(restoredIdentityRemovalTask(record({ domain: a.domain, appId: a.appId }), saved, owner)?.operationId).toBe('old-unknown')
  const management = { kind: 'management' as const, connectionId: 'robot-a', adapterId: 'native', domain: a.domain, appId: a.appId, issuer: a.issuer }
  const key = botTaskSelectionKey(management), result = restoredManagementTask({ management: key, [key]: { operationId: 'management-a', hostingTarget: owner } })
  expect(result?.scope).toEqual(management)
  expect(botTaskSelectionKey({ ...management, issuer: b.issuer })).not.toBe(key)
})

it('keeps member drafts by native issuer and the actual member editor never shows an alien grant as current access', async () => {
  const binding = { bindingId: 'binding-a', revision: 1, application: a, state: 'active' } as any
  const aa = actor(a), bb = actor(b)
  const one = editConnectorMemberDraft({}, binding, aa, null, ['input'])
  const both = editConnectorMemberDraft(one, binding, bb, null, ['answer'])
  expect(connectorMemberKey(binding, aa)).not.toBe(connectorMemberKey(binding, bb))
  expect(Object.keys(restoredConnectorMemberDrafts(both))).toHaveLength(2)
  const draft = (person: typeof aa) => ({ adapterId: 'native', actor: person, baseline: null, decision: 'rule' as const, capabilities: ['input' as const] })
  const appDrafts = { [applicationMemberKey('native', aa)]: draft(aa), [applicationMemberKey('native', bb)]: draft(bb) }
  expect(Object.keys(restoredApplicationAccess({ drafts: appDrafts, requests: {} }).drafts)).toHaveLength(2)
  const alien = { actor: bb, local: { kind: 'none', previousDecision: false }, effective: { state: 'active', capabilities: ['input'] } }
  const facts = { people: { members: [{ idType: 'open_id', userId: 'same-user', name: 'Original' }], observation: { state: 'ready' } }, profiles: new Map(), pending: false, issue: '', refresh: vi.fn() }
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
  try {
    await act(async () => root.render(<ConnectorMemberAccess binding={binding} facts={facts as any} grants={[]} access={[alien] as any} creator={null} drafts={{}} changeDrafts={vi.fn()} account={{ idType: '', userId: '', change: vi.fn() }} requests={[]} flights={new Map()} save={vi.fn()} inspect={vi.fn()} resume={vi.fn()} review={vi.fn()} />))
    expect(node.textContent).toContain('No access')
    expect(node.textContent).not.toContain('Send requests ·')
  } finally { await act(async () => root.unmount()); node.remove() }
})


it('checks the retained deletion in its original host and refuses to continue against a replacement issuer', async () => {
  f = await moteConnectionJourney()
  const config = { connectionId: 'delete-scoped', adapterId: 'feishu', application: a, label: 'Original A', enabled: true, credentialRef: 'unused-delete' }
  await f.services.connections.configure({ operationId: 'seed-delete', expectedRevision: null, connection: config })
  const record = (await f.services.connections.inspect({ connectionId: config.connectionId })).connection!
  const scope = { kind: 'identity-removal' as const, connectionId: config.connectionId, adapterId: config.adapterId, domain: a.domain, appId: a.appId, issuer: a.issuer, expectedRevision: record.revision, hostingTarget: owner }
  const key = botTaskSelectionKey(scope), locator = { operationId: 'original-delete', hostingTarget: owner }
  useAppStore.setState({ botTaskSelections: { [key]: locator } })
  const forward = f.connections.getMockImplementation()!, calls: string[] = []
  let current = b
  f.connections.mockImplementation(async (method, input, target) => {
    calls.push(method)
    const result = await forward(method, input, target)
    if (method !== 'connection.inspect' || !result.connection) return result
    return { ...result, connection: { ...result.connection, config: { ...result.connection.config, application: current } } } as typeof result
  })
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node), deleted = vi.fn()
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!
  try {
    await act(async () => root.render(<ConnectionIdentityRemoval record={record} readings={{ items: [], complete: true, reading: false } as any} active hostingTarget={owner} onDeleted={deleted} />))
    await act(async () => button('Review identity removal').click())
    await act(async () => button('Check original removal').click())
    await vi.waitFor(async () => { await act(async () => {}); expect(button('Continue original removal')).toBeDefined() })
    await act(async () => button('Continue original removal').click())
    await vi.waitFor(async () => { await act(async () => {}); expect(document.body.textContent).toContain('original removal target is not confirmed') })
    expect(calls.filter(method => method === 'connection.delete')).toHaveLength(0)
    expect(useAppStore.getState().botTaskSelections[key]).toEqual(locator)
    current = a
    await vi.waitFor(async () => { await act(async () => {}); expect(button('Check original removal')).toBeDefined() })
    await act(async () => button('Check original removal').click())
    await vi.waitFor(async () => { await act(async () => {}); expect(button('Continue original removal')).toBeDefined() })
    await act(async () => button('Continue original removal').click())
    await vi.waitFor(async () => { await act(async () => {}); expect(deleted).toHaveBeenCalledOnce() })
    expect(calls.filter(method => method === 'connection.delete')).toHaveLength(1)
    expect(deleted.mock.calls[0]![0].application).toEqual(a)
  } finally { await act(async () => root.unmount()); node.remove() }
})


it('the shared conversation resolver keeps issuer-scoped speakers and room observations separate', () => {
  const author = { kind: 'external', actor: actor(a), externalConversationId: 'same-room' } as any
  const speaker = speakerOfExternalAuthor(author), foreign = speakerOfExternalAuthor({ ...author, actor: actor(b) })
  expect(speaker.id).not.toBe(foreign.id)
  const resolve = createSpeakerResolver({ lookupExternal: () => ({ conversation: { application: b, externalConversationId: 'same-room', profile: { name: 'Other server room' } } as any }) })
  expect(resolve(speaker).channelConversation).toBeUndefined()
  expect(resolve(foreign).channelConversation?.application).toEqual(b)
})
