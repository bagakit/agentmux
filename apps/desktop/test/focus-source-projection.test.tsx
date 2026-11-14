// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import type { SpaceSnapshot } from '@agentmux/core'
import type { SpaceMountMemberSurface, SpaceMountRecord } from '../src/shared/space-mount'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { agentContextForSession, focusNeutralGroupSummary } from '../src/renderer/src/lib/focus-context'
import { focusMatchesState } from '../src/renderer/src/lib/focus-filters'
import { focusSourceWorkspace, matchingFocusContext, unobservedFocusContext } from '../src/renderer/src/lib/focus-source-model'
import { sourceConversationPort } from '../src/renderer/src/lib/focus-source-conversation'
import type { ConversationObservation } from '@agentmux/core/conversation'
import type { MountedSpaceRegion } from '../src/renderer/src/lib/space-mount-view'
import { useFocusSources } from '../src/renderer/src/lib/use-focus-sources'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('reuses the actual ordinary Context only with the original Runtime and canonical SID witness', () => {
  const session = composerSession('presentation-key')
  session.control.agentSessionId = 'original-sid'
  const context = agentContextForSession(session, undefined, 'Original task name', composerConfig.workspaces[0], null)
  expect(matchingFocusContext([context], new Map(), 'runtime-b', 'original-sid')).toBeUndefined()
  expect(matchingFocusContext([context], new Map([['local', 'runtime-a']]), 'runtime-b', 'original-sid')).toBeUndefined()
  expect(matchingFocusContext([context], new Map([['local', 'runtime-b']]), 'runtime-b', 'original-sid')).toBe(context)
  expect(matchingFocusContext([context], new Map([['local', 'runtime-b']]), 'runtime-b', 'presentation-key')).toBeUndefined()
})

it('two access routes preserve one original configured project by exact resource and Runtime, without guessing from cwd', () => {
  const resource = composerConfig.workspaces[0]!, target: SpaceMountRecord = { hostId: 'source-route', reference: { runtimeId: 'runtime-b', spaceId: 'space-b' }, zoneId: 'zone', workspaceId: resource.id }
  const member = { zone: { zoneId: 'zone', workspaceId: resource.id, hostId: 'local', directoryPath: resource.path, kind: 'directory' } } as MountedSpaceRegion
  const snapshot = { scope: { space: { kind: 'folder', name: 'Original project', directoryPath: resource.path } } } as SpaceSnapshot
  expect(focusSourceWorkspace(target, member, snapshot, composerConfig, new Map([['local', 'runtime-b']]))).toBe(resource)
  expect(focusSourceWorkspace(target, member, snapshot, composerConfig, new Map([['local', 'runtime-a']]))?.hostId).toBe(JSON.stringify(['source-host', 'runtime-b', 'local']))
  expect(focusSourceWorkspace({ ...target, hostId: 'local' }, member, snapshot, composerConfig)).not.toBe(resource)
  const changed = { ...member, zone: { ...member.zone!, directoryPath: resource.path + '/different-resource' } }
  expect(focusSourceWorkspace(target, changed, snapshot, composerConfig, new Map([['local', 'runtime-b']]))).not.toBe(resource)
})

it('a source locator without a Run stays an unknown Context and cannot acquire recovery or control', () => {
  const access = { identity: { runtimeId: null, agentSessionId: 'original-sid' }, locations: [], open() {}, select() {}, refresh() {} }
  const context = unobservedFocusContext('', 'original-sid', composerConfig.workspaces[0], undefined, 'Original metadata unavailable', access)
  expect(context.control).toBeUndefined()
  expect(context.runUnobserved).toBe(true)
  expect(focusMatchesState(context, ['unknown'])).toBe(true)
  expect(focusMatchesState(context, ['recovery'])).toBe(false)
  expect(focusNeutralGroupSummary([context])).toMatchObject({ label: 'Activity unknown' })
})

it('the shared conversation port refuses another original target without ever selecting observer-local input', async () => {
  const call = vi.fn(), surface = { call } as unknown as SpaceMountMemberSurface
  const port = sourceConversationPort(surface, 'original-sid', new Map(), new AbortController().signal)
  expect(() => port.readAgentConversation({ hostId: 'local', agentSessionId: 'other-sid' })).toThrow('another original Agent')
  expect(() => port.readAgentConversation({ hostId: 'observer-host', agentSessionId: 'original-sid' })).toThrow('another original Agent')
  expect(call).not.toHaveBeenCalled()
})

it('independent source conversation readers retain separate leases through dismissal and Source closure', async () => {
  let serial = 0
  const call = vi.fn(async (method: string) => method === 'conversationWatch' ? { hostId: 'local', agentSessionId: 'original-sid', sourceHostId: 'local', scope: { sources: [] }, coverage: [], readerId: 'reader-' + ++serial } : undefined)
  const surface = { call } as unknown as SpaceMountMemberSurface, listeners = new Map<string, (event: ConversationObservation) => void>(), lifetime = new AbortController()
  const port = sourceConversationPort(surface, 'original-sid', listeners, lifetime.signal), first = vi.fn(), second = vi.fn()
  const a = await port.observeConversation({ hostId: 'local', agentSessionId: 'original-sid' }, first)
  const b = await port.observeConversation({ hostId: 'local', agentSessionId: 'original-sid' }, second)
  expect(listeners.size).toBe(2)
  a.dispose()
  expect(call).toHaveBeenCalledWith('conversationUnwatch', { readerId: 'reader-1' })
  expect(listeners.has('reader-2')).toBe(true)
  expect(b.closed.aborted).toBe(false)
  lifetime.abort()
  expect(call).toHaveBeenCalledWith('conversationUnwatch', { readerId: 'reader-2' })
  expect(listeners.size).toBe(0)
  expect(b.closed.aborted).toBe(true)
})

it('changing a Host configuration revokes only its old alias witness until the current owner responds', async () => {
  const resource = composerConfig.workspaces[0]!, reference = { runtimeId: 'runtime-b', spaceId: 'original-space' }
  const target: SpaceMountRecord = { hostId: 'local', reference, zoneId: 'original-zone', workspaceId: resource.id }
  const source = { runtimeId: reference.runtimeId, ownerInstanceId: 'source-owner' }, snapshot = { reference, source, revision: 1,
    scope: { space: { spaceId: reference.spaceId, kind: 'folder', name: resource.name, directoryPath: resource.path, hostId: 'local', projectId: null },
      zones: [{ zoneId: target.zoneId, workspaceId: resource.id, hostId: 'local', directoryPath: resource.path, kind: 'directory', branch: null }],
      tabs: [{ tabId: 'original-tab', zoneId: target.zoneId, workspaceId: resource.id, name: null, regionIds: ['original-region'] }],
      regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'agent', agentSessionId: 'original-sid', runId: null, execution: { hostId: 'local', cwd: resource.path } }], bindings: [] } } as SpaceSnapshot
  vi.spyOn(api.spaceMounts, 'watch').mockResolvedValue({ initial: snapshot, dispose() {} })
  vi.spyOn(api.spaceMounts, 'sessions').mockResolvedValue({ initial: { reference, source, revision: 1 }, dispose() {} })
  let answer: ((value: { hostId: string; runtimeId: string; workspaces: [] }) => void) | undefined
  const witness = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async method => {
    if (method !== 'resources') throw Error('Only the original owner witness may be read')
    if (witness.mock.calls.length === 1) return { hostId: 'local', runtimeId: 'runtime-b', workspaces: [] } as never
    return await new Promise(resolve => { answer = resolve }) as never
  })
  const member = vi.spyOn(api.spaceMounts, 'member')
  useAppStore.getState().mountSpace(target, false)
  const session = composerSession('original-sid'), context = agentContextForSession(session, undefined, 'Keep original task', resource, null), contexts = [context]
  function Consumer() {
    const value = useFocusSources({ visible: true, contexts })
    return <>{value.readers}<output data-aliases>{value.aliases.size}</output><output data-source-contexts>{value.contexts.length}</output></>
  }
  await dom.render(<Consumer />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelector('[data-aliases]')?.textContent).toBe('1')) })
  const before = useAppStore.getState().config!
  await act(async () => { useAppStore.setState({ config: { ...before, hosts: before.hosts.map(host => ({ ...host, label: 'Changed original configuration' })) } }) })
  expect(dom.container.querySelector('[data-aliases]')?.textContent).toBe('0')
  expect(dom.container.querySelector('[data-source-contexts]')?.textContent).toBe('1')
  await act(async () => { answer!({ hostId: 'local', runtimeId: 'runtime-c', workspaces: [] }) })
  expect(dom.container.querySelector('[data-aliases]')?.textContent).toBe('0')
  expect(context.name).toBe('Keep original task')
  expect(member).not.toHaveBeenCalled()
})
