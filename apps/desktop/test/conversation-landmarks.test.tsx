// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationLandmarkStore } from '@agentmux/core'
import type { ConversationItemRef, ConversationLandmarkPage } from '@agentmux/core/conversation'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationLandmarkList, SaveConversationLandmark, renderConversationLandmarkAction } from '../src/renderer/src/components/ConversationLandmarks'
import { createConversationLandmarksApi } from '../src/renderer/src/lib/conversation-landmarks-api'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

let root: Root, host: HTMLDivElement, directory: string, store: ConversationLandmarkStore
const scope = { hostId: 'original-host', agentSessionId: 'original-session' }, actor = { kind: 'user', id: 'original-user' } as const
const ref = (source = 'source-a'): ConversationItemRef => ({ ...scope, source: { kind: 'native', providerId: 'reading-provider', nativeSessionId: source, recordId: 'original-message' } })
const page = (): AgentSessionHistoryPage => ({ agentSessionId: scope.agentSessionId, sourceHostId:scope.hostId, source: { providerId: 'reading-provider', nativeSessionId: 'source-a' }, nextCursor: null, items: [
  { id: 'original-message', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original body remains selectable.' }] },
  { id: 'answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original answer remains readable.' }] },
  { id: 'system', kind: 'system-message', contentParts: [{ kind: 'text', text: 'Recorded original notice.' }] }
] })
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const render = async (node: ReactNode) => { await act(async () => root.render(node)); await tick() }
const click = async (node: HTMLElement) => { expect(node).not.toBeNull(); await act(async () => node.click()); await tick() }
const named = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === text)!
const input = () => document.querySelector<HTMLInputElement>('.conversation-landmark input')!
const edit = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })) }); await tick() }
async function until(assertion: () => void) { let failure: unknown; for (let attempt = 0; attempt < 150; attempt++) { await tick(); try { assertion(); return } catch (error) { failure = error }; await new Promise(resolve => setTimeout(resolve, 5)) } throw failure }
const savedStatus = () => expect(document.body.textContent).toContain('Saved. Return from Reading points.')
const submit = async () => { await act(async () => document.querySelector('.conversation-landmark form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await tick() }
async function saved(reference = ref(), name = 'Original point', id = 'original-point') { return store.apply({ ...scope, operationId: id + '-create', expectedRevision: (await store.list(scope)).revision, change: { kind: 'create', point: { id, name, reference } } }, actor) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  useAppStore.setState({ conversationLandmarkIntents: {}, workbenchSaveWarning: null })
  directory = await mkdtemp(join(tmpdir(), 'amx-reading-point-ui-')); store = new ConversationLandmarkStore(join(directory, 'points.json'))
  const original = createConversationLandmarksApi({ list: value => store.list(value), apply: value => store.apply(value, actor) })
  vi.spyOn(api.landmarks, 'list').mockImplementation(original.list); vi.spyOn(api.landmarks, 'apply').mockImplementation(original.apply)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })
it('names the actual common native record without reading metadata on mount or replacing its body/Range', async () => {
  await render(<ConversationView page={page()} sessionId={scope.agentSessionId} executionHostId={scope.hostId} renderRecordActions={renderConversationLandmarkAction}/>)
  expect(api.landmarks.list).not.toHaveBeenCalled(); expect(host.querySelectorAll('[aria-label="Name reading point"]')).toHaveLength(3)
  const body = host.querySelector('[data-native-record-id="original-message"] .log-turn__text p')!, range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range)
  await click(named('Name reading point')); await edit('Named original input'); await submit(); await until(savedStatus)
  expect((await store.list(scope)).points[0]).toMatchObject({ name: 'Named original input', reference: ref() })
  expect(host.querySelector('[data-native-record-id="original-message"] .log-turn__text p')).toBe(body); expect(range.toString()).toBe('Original body remains selectable.'); expect(document.body.textContent).toContain('Saved. Return from Reading points.')
})
it('contributes the same exact action to actual captured Activity records without forging native source', async () => {
  const originalItem = { id: 'captured-answer', agentSessionId:scope.agentSessionId,kind:'assistant_message' as const,title:'Original',content:'Captured original answer.',status:'complete' as const,source:'native-hook' as const,createdAt:_historyFixtureEpoch(0, 0, 1),updatedAt:_historyFixtureEpoch(0, 0, 1)}
  await render(<ActivityView timelineSnapshot={{agentSessionId:scope.agentSessionId,sourceHostId:scope.hostId,revision:1,items:[originalItem]}} sessionId={scope.agentSessionId} executionHostId={scope.hostId} items={[{ id: 'captured-answer', agentSessionId: scope.agentSessionId, kind: 'assistant_message', title: 'Original', content: 'Captured original answer.', status: 'complete', source: 'native-hook', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }]} capability="complete-events" renderRecordActions={renderConversationLandmarkAction}/>)
  await click(named('Name reading point')); await edit('Captured point'); await submit(); await until(savedStatus)
  expect((await store.list(scope)).points[0]?.reference).toEqual({ ...scope, source: { kind: 'captured', recordId: 'captured-answer' } })
})
it('lazily lists original points and renames/removes through the actual durable owner', async () => {
  await saved(); const reveal = vi.fn(async () => ({ kind: 'located' as const }))
  await render(<ConversationLandmarkList reference={scope} reveal={reveal} active/>); expect(api.landmarks.list).not.toHaveBeenCalled()
  await click(named('Reading points')); await until(() => expect(named('Rename Original point')).not.toBeNull())
  await click(named('Rename Original point')); await edit('Renamed point'); await submit(); await until(() => expect(named('Remove Renamed point')).not.toBeNull()); expect((await store.list(scope)).points[0]?.name).toBe('Renamed point')
  await click(named('Rename Renamed point')); await edit('Second name'); await submit(); await until(() => expect(named('Remove Second name')).not.toBeNull()); await click(named('Remove Second name')); await until(() => expect(document.body.textContent).toContain('No named points in this conversation.')); expect((await store.list(scope)).points).toEqual([]); expect(document.body.textContent).toContain('No named points in this conversation.'); expect(reveal).not.toHaveBeenCalled()
})
it('keeps the original save after a lost reply and retries exactly the same immutable operation', async () => {
  const write = vi.spyOn(api.landmarks, 'apply'), attempts: any[] = []; write.mockImplementation(async value => { attempts.push(structuredClone(value)); const result = await store.apply(value, actor); if (attempts.length === 1) throw Object.assign(new Error('Original write reply unavailable'), { code: 'ACK_UNKNOWN' }); return result })
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); await edit('Retained name'); await submit(); await until(() => expect(document.body.textContent).toContain('Original write reply unavailable'))
  await click(named('Close Name reading point')); await click(named('Name reading point')); expect(input().readOnly).toBe(true); expect(input().value).toBe('Retained name'); expect(document.body.textContent).toContain('Original write reply unavailable')
  await click(button('Retry original save')); await until(savedStatus); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect((await store.list(scope)).points).toHaveLength(1); expect(document.body.textContent).toContain('Saved. Return from Reading points.')
})
it('creates again from the same original mounted record after removing its confirmed point', async () => {
  await render(<><SaveConversationLandmark reference={ref()}/><ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'located' })} active/></>)
  await click(named('Name reading point')); await edit('First saved point'); await submit(); await until(savedStatus)
  const originalId = (await store.list(scope)).points[0]!.id
  await click(named('Close Name reading point')); await click(named('Reading points')); await until(() => expect(named('Remove First saved point')).not.toBeNull()); await click(named('Remove First saved point')); await until(() => expect(document.body.textContent).toContain('No named points in this conversation.')); await click(named('Close Reading points'))
  await click(named('Name reading point')); expect(input().readOnly).toBe(false); expect(input().value).toBe(''); await edit('Second saved point'); await submit(); await until(savedStatus)
  const points = (await store.list(scope)).points; expect(points).toHaveLength(1); expect(points[0]!.id).not.toBe(originalId); expect(points[0]!.reference).toEqual(ref()); expect(points[0]!.name).toBe('Second saved point')
})
it('keeps the rejected name and requires an explicit new save after a real global revision conflict', async () => {
  let conflict = true
  vi.spyOn(api.landmarks, 'apply').mockImplementation(async value => {
    if (conflict) { conflict = false; const other = { hostId: 'other-host', agentSessionId: 'other-session' }; await store.apply({ ...other, operationId: 'unrelated-manual-write', expectedRevision: 0, change: { kind: 'create', point: { id: 'unrelated', name: 'Other point', reference: { ...other, source: { kind: 'captured', recordId: 'other-record' } } } } }, actor) }
    return store.apply(value, actor)
  })
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); await edit('Keep this name'); await submit(); await until(() => expect(button('Refresh after conflict')).not.toBeUndefined()); expect(input().readOnly).toBe(true)
  await click(button('Refresh after conflict')); await until(() => expect(input().readOnly).toBe(false)); expect(input().value).toBe('Keep this name'); expect((await store.list(scope)).points).toHaveLength(0); expect(api.landmarks.apply).toHaveBeenCalledTimes(1)
  await submit(); await until(savedStatus); expect((await store.list(scope)).points[0]!.name).toBe('Keep this name'); expect(api.landmarks.apply).toHaveBeenCalledTimes(2)
})
it('checks the original durable receipt without resending after an unknown save', async () => {
  vi.spyOn(api.landmarks, 'apply').mockImplementation(async value => { await store.apply(value, actor); throw new Error('Original reply missing') })
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); await edit('Receipt point'); await submit(); await until(() => expect(button('Check original save')?.disabled).toBe(false)); await click(button('Check original save')); await until(savedStatus)
  expect(api.landmarks.apply).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain('Saved. Return from Reading points.'); expect((await store.list(scope)).points).toHaveLength(1)
})
it('does not carry source A naming intent or its late completion through A-B-A', async () => {
  let finish!: (page: ConversationLandmarkPage) => void, original!: ConversationLandmarkPage
  vi.spyOn(api.landmarks, 'apply').mockImplementation(async value => { original = await store.apply(value, actor); return new Promise(resolve => { finish = resolve }) })
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); await edit('Only first A'); await submit(); await until(() => expect(finish).toBeTypeOf('function'))
  await render(<SaveConversationLandmark reference={ref('source-b')}/>); expect(document.querySelector('.conversation-landmark')).toBeNull(); await click(named('Name reading point')); expect(input().value).toBe('')
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); expect(input().value).toBe('Only first A'); expect(input().readOnly).toBe(true); await act(async () => finish(original)); await tick()
  expect(document.body.textContent).not.toContain('Saved. Return from Reading points.'); await click(button('Check original save')); await until(savedStatus); expect(api.landmarks.apply).toHaveBeenCalledTimes(1); expect((await store.list(scope)).points[0]?.reference).toEqual(ref()); expect(Object.keys(useAppStore.getState().conversationLandmarkIntents)).toHaveLength(0)
})
it('recovers an unknown original operation in the reading tool while its message is outside the loaded window', async () => {
  vi.spyOn(api.landmarks, 'apply').mockImplementation(async value => { await store.apply(value, actor); throw new Error('Original reply unavailable') })
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); await edit('Off-window pending point'); await submit(); await until(() => expect(button('Check original save')?.disabled).toBe(false))
  const original = Object.values(useAppStore.getState().conversationLandmarkIntents)[0]!
  expect(document.body.textContent).toContain(original.operationId)
  await render(<ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'unavailable', message: 'Read the original record window.' })} active/>); await click(named('Reading points')); await until(() => expect(button('Check original save')?.disabled).toBe(false)); expect(document.body.textContent).toContain(original.operationId)
  await click(button('Check original save')); await until(() => expect(Object.keys(useAppStore.getState().conversationLandmarkIntents)).toHaveLength(0)); expect(api.landmarks.apply).toHaveBeenCalledTimes(1); expect((await store.list(scope)).points).toHaveLength(1)
})
it('shows one original receipt recovery after a list rename loses its reply', async () => {
  await saved(); vi.spyOn(api.landmarks, 'apply').mockImplementation(async value => { await store.apply(value, actor); throw new Error('Original rename reply unavailable') })
  await render(<ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'located' })} active/>); await click(named('Reading points')); await until(() => expect(named('Rename Original point')).not.toBeNull())
  await click(named('Rename Original point')); await edit('One pending rename'); await submit(); await until(() => expect(document.body.textContent).toContain('Original rename reply unavailable'))
  expect(Array.from(document.querySelectorAll('button')).filter(node => node.textContent === 'Check original save')).toHaveLength(1)
  await click(button('Check original save')); await until(() => expect(named('Remove One pending rename')).not.toBeNull()); expect(Object.keys(useAppStore.getState().conversationLandmarkIntents)).toHaveLength(0)
  expect(named('Rename One pending rename').disabled).toBe(false); expect(api.landmarks.apply).toHaveBeenCalledTimes(1)
})
it('explicitly reviews the original missing-point rejection and unlocks the other saved points', async () => {
  await saved(); await saved(ref('source-b'), 'Other point', 'other-point')
  await render(<ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'located' })} active/>); await click(named('Reading points')); await until(() => expect(named('Rename Original point')).not.toBeNull())
  await store.apply({ ...scope, operationId: 'external-remove', expectedRevision: (await store.list(scope)).revision, change: { kind: 'remove', id: 'original-point' } }, actor)
  await click(named('Rename Original point')); await edit('Unavailable original point'); await submit(); await until(() => expect(button('Review missing point')).not.toBeUndefined())
  expect(named('Rename Other point').disabled).toBe(true); const original = Object.values(useAppStore.getState().conversationLandmarkIntents)[0]!
  await click(button('Review missing point')); await until(() => expect(named('Rename Other point')?.disabled).toBe(false)); expect(Object.keys(useAppStore.getState().conversationLandmarkIntents)).toHaveLength(0)
  expect((await store.list({ ...scope, operationId: original.operationId })).recordedOperation).toBeNull(); expect(api.landmarks.apply).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain('because its point no longer exists')
})
it('reconciles its original operation on explicit reopen after another reading tool confirms it', async () => {
  vi.spyOn(api.landmarks, 'apply').mockImplementation(async value => { await store.apply(value, actor); throw new Error('Original receipt unavailable') })
  await render(<><SaveConversationLandmark reference={ref()}/><ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'located' })} active/></>)
  await click(named('Name reading point')); await edit('Same original intent'); await submit(); await until(() => expect(button('Check original save')?.disabled).toBe(false)); await click(named('Close Name reading point'))
  await click(named('Reading points')); await until(() => expect(button('Check original save')?.disabled).toBe(false)); await click(button('Check original save')); await until(() => expect(Object.keys(useAppStore.getState().conversationLandmarkIntents)).toHaveLength(0)); await click(named('Close Reading points'))
  await click(named('Name reading point')); await until(savedStatus); await click(named('Close Name reading point')); await click(named('Name reading point')); expect(input().readOnly).toBe(false); expect(input().value).toBe(''); expect(api.landmarks.apply).toHaveBeenCalledTimes(1)
})
it('hands initial focus to the original popup only after its floating position becomes visible', async () => {
  await render(<><SaveConversationLandmark reference={ref()}/><ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'located' })} active/></>)
  await click(named('Name reading point')); await until(() => expect(document.activeElement).toBe(input())); expect(document.querySelector<HTMLElement>('.conversation-landmark')!.style.visibility).toBe('visible')
  await click(named('Close Name reading point')); await click(named('Reading points')); await until(() => expect(document.activeElement).toBe(named('Close Reading points'))); expect(document.querySelector<HTMLElement>('.conversation-landmark')!.style.visibility).toBe('visible')
})
it('preserves IME Enter as editing rather than creating a reading point', async () => {
  await render(<SaveConversationLandmark reference={ref()}/>); await click(named('Name reading point')); await edit('组字中的名字')
  const enter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true, isComposing: true }); await act(async () => input().dispatchEvent(enter))
  expect(enter.defaultPrevented).toBe(true); expect(api.landmarks.apply).not.toHaveBeenCalled(); expect(input().value).toBe('组字中的名字')
})
it('rejects another original metadata response at the real renderer adapter', async () => {
  const actual = await saved(), bridge = createConversationLandmarksApi({ list: async () => ({ ...actual, hostId: 'other-host' }), apply: async () => actual })
  await expect(bridge.list(scope)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }); expect((await store.list(scope)).points[0]?.reference).toEqual(ref())
})
it('passes the complete original reference to navigation and keeps unknown records in the list', async () => {
  await saved(); const reveal = vi.fn(async () => ({ kind: 'unavailable' as const, message: 'Original source temporarily unavailable. Point retained.' }))
  await render(<ConversationLandmarkList reference={scope} reveal={reveal} active/>); await click(named('Reading points')); await until(() => expect(document.querySelector('.conversation-landmark__destination')).not.toBeNull()); await click(document.querySelector<HTMLButtonElement>('.conversation-landmark__destination')!)
  expect(reveal).toHaveBeenCalledWith(ref(), scope.hostId); expect(document.body.textContent).toContain('Original source temporarily unavailable. Point retained.'); expect((await store.list(scope)).points).toHaveLength(1)
})
it('returns to the exact already-loaded record in the original Activity reader without a Run or second reader', async () => {
  await saved(); let local!: Parameters<NonNullable<Parameters<typeof ActivityView>[0]['renderReadingTools']>>[1]
  const reads = vi.spyOn(api.sessions, 'historyPage'), view = <ActivityView sessionId={scope.agentSessionId} executionHostId={scope.hostId} nativeHistoryPage={page()} items={[]} capability="complete-events" renderReadingTools={(active, revealLoaded) => { local = revealLoaded; return <ConversationLandmarkList reference={scope} active={active} reveal={revealLoaded}/> }}/>
  await render(view)
  const original = host.querySelector<HTMLElement>('[data-native-record-id="original-message"] .log-turn')!, head = original.querySelector<HTMLElement>('.log-turn__head')!, viewport = host.querySelector<HTMLElement>('.activity-feed')!
  vi.spyOn(head, 'getBoundingClientRect').mockReturnValue({ x: 1, y: 20, left: 1, right: 100, top: 20, bottom: 40, width: 99, height: 20, toJSON() {} }); vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, right: 200, top: 0, bottom: 300, width: 200, height: 300, toJSON() {} })
  const scroll = vi.spyOn(head, 'scrollIntoView').mockImplementation(() => {})
  await click(named('Reading points')); await until(() => expect(document.querySelector('.conversation-landmark__destination')).not.toBeNull()); await click(document.querySelector<HTMLButtonElement>('.conversation-landmark__destination')!); expect(scroll).toHaveBeenCalled(); expect(document.activeElement).toBe(original); expect(reads).not.toHaveBeenCalled()
  expect(await local(ref('another-native-source'))).toMatchObject({ kind: 'unavailable' }); expect(await local({ ...ref(), hostId: 'other-host' })).toMatchObject({ kind: 'unavailable' }); expect((await store.list(scope)).points).toHaveLength(1)
})

it('separates the original source reference from two route catalogs at the actual shared action and retained-intent boundary',async()=>{
  const sourceRef={...ref(),hostId:'semantic-owner'},route='route-a'
  await render(<SaveConversationLandmark reference={sourceRef} routeHostId={route}/>)
  await click(named('Name reading point'));await edit('Scoped source record');await submit();await until(savedStatus)
  const catalog=await store.list({hostId:route,agentSessionId:scope.agentSessionId})
  expect(catalog.points).toHaveLength(1)
  expect(catalog.points[0]).toMatchObject({reference:sourceRef,routeHostId:route})
  expect((await store.list({hostId:'route-b',agentSessionId:scope.agentSessionId})).points).toEqual([])
  const original=vi.mocked(api.landmarks.apply).mock.calls[0]![0]
  expect(original.hostId).toBe(route)
  if(original.change.kind!=='create')throw Error('Expected exact original create')
  expect(original.change.point.reference).toEqual(sourceRef)
  const {conversationLandmarkIntentKey}=await import('../src/renderer/src/lib/conversation-landmark-intent')
  const other={...original,hostId:'route-b',change:{...original.change,point:{...original.change.point,routeHostId:'route-b'}}}
  expect(conversationLandmarkIntentKey(original)).not.toBe(conversationLandmarkIntentKey(other))
})
