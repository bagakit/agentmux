// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState()
const ids = ['original-a', 'original-b']
const empty = (): RuntimeSnapshot => ({ sessions: [], recoveryCandidates: [], timelines: {} })
const complete = (): RuntimeSnapshot => ({
  ...empty(), sessions: ids.map(id => composerSession(id)),
  timelines: Object.fromEntries(ids.map(id => [id, { agentSessionId: id, revision: 1, items: [] }]))
})
const unknownEvent = (): RuntimeEvent => ({ type: 'core', hostId: 'local', event: {
  type: 'agent-status', agentSessionId: 'unrelated-event', state: 'working',
  evidence: { source: 'native-hook', observedAt: 1 }
} })
function Notices() {
  const state = useAppStore()
  return <TransientErrorNotice error={state.error} dismissed={state.errorDismissed} lastError={state.lastError}
    onDismiss={state.dismissError} onReopen={state.reopenError} kind={state.errorNoticeContext?.kind ?? 'indeterminate'} />
}
let root: Root, element: HTMLDivElement, dispose: (() => void) | undefined, releasePending: (() => void) | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => {
  await act(async () => {
    // An assertion may fail before releasing the deferred read; it must not become the next case's owner.
    releasePending?.(); releasePending = undefined; await new Promise(done => setTimeout(done, 0))
    dispose?.(); dispose = undefined; root.unmount()
  })
  element.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function fixture(bufferedEvent = false, overflow?: 'complete' | 'partial') {
  const tabs = Object.fromEntries(ids.map(id => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    kind: 'agent', regionId: `region-${id}`, workspaceId: 'workspace', sessionId: id, phase: 'attached'
  })]))
  const original = { tabs, layouts: { workspace: createWorkspaceLayout('original-group', Object.keys(tabs)) },
    agentFocus: { execution: { sessionId: ids[0]!, history: [{ sessionId: ids[0]!, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { 'original-a': '原来的未发送草稿', 'original-b': 'Original neighbor draft' } }
  useAppStore.setState({ restoredWorkbench: { tabs, layouts: original.layouts }, loading: true,
    agentFocus: original.agentFocus, agentComposerDrafts: original.agentComposerDrafts, activeWorkspaceId: 'workspace' })
  let listener: (event: RuntimeEvent) => void = () => {}
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(callback => { listener = callback; return () => {} })
  let resolve!: (snapshot: RuntimeSnapshot) => void, reject!: (error: Error) => void
  const pending = new Promise<RuntimeSnapshot>((yes, no) => { resolve = yes; reject = no })
  releasePending = () => resolve(empty())
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementationOnce(async () => {
    if (overflow) for (let index = 0; index < 257; index += 1) listener(unknownEvent())
    else if (bufferedEvent) listener(unknownEvent())
    return empty()
  })
  if (overflow) snapshot.mockResolvedValueOnce(overflow === 'complete'
    ? complete() : { ...complete(), sessions: complete().sessions.slice(0, 1) })
  snapshot.mockReturnValue(pending)
  await act(async () => { root.render(<Notices />); dispose = await useAppStore.getState().initialize() })
  expect(useAppStore.getState().loading).toBe(false)
  expect(snapshot).toHaveBeenCalledTimes(overflow === 'partial' ? 3 : 2)
  if (overflow === 'complete') {
    expect(useAppStore.getState().errorNoticeContext).toBeNull()
    expect(element.querySelector('.error-notice')).toBeNull()
  } else {
    expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds).toEqual(ids)
    expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
    expect(element.querySelector('.error-notice')!.textContent).toContain('Runtime Session snapshot returned no Session facts')
  }
  const warning = useAppStore.getState().error!
  const settle = async (result: RuntimeSnapshot | Error) => {
    await act(async () => { result instanceof Error ? reject(result) : resolve(result); await new Promise(done => setTimeout(done, 0)) })
  }
  const retained = () => {
    expect(useAppStore.getState().tabs).toEqual(original.tabs)
    expect(useAppStore.getState().layouts).toEqual(original.layouts)
    expect(useAppStore.getState().agentFocus).toEqual(original.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(original.agentComposerDrafts)
  }
  retained()
  return { settle, retained, warning, snapshot }
}
it('initialization consumes complete overflow facts without another read', async () => {
  const f = await fixture(false, 'complete')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  expect(f.snapshot).toHaveBeenCalledTimes(2)
  f.retained()
})
it('partial overflow keeps the original scope until later complete facts arrive', async () => {
  const f = await fixture(false, 'partial')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([ids[0]])
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toEqual({ sessionIds: ids, remainingMessage: null })
  expect(f.warning).not.toContain('saved Session reference(s) have no current Runtime facts')
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice')).toBeNull()
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  expect(f.snapshot).toHaveBeenCalledTimes(3)
  f.retained()
})
it.each([false, true])('settles only the adopted complete original facts (buffered entry: %s)', async buffered => {
  const f = await fixture(buffered)
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice')).toBeNull()
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  f.retained()
})
it.each(['empty', 'partial', 'candidate', 'related-host', 'rejected', 'invalid-timeline'] as const)('keeps unresolved %s facts visible', async mode => {
  const f = await fixture()
  let snapshot: RuntimeSnapshot | Error = complete()
  if (mode === 'empty') snapshot = empty()
  if (mode === 'partial') snapshot = { ...complete(), sessions: complete().sessions.slice(0, 1) }
  if (mode === 'candidate') snapshot = { ...empty(), recoveryCandidates: complete().sessions.map(session => ({
    ...session, agentSessionId: session.id, providerId: 'codex', executorId: 'codex', run: session.control.run
  })) }
  if (mode === 'related-host') snapshot = { ...complete(), runtimeOwnershipWarnings: ['local'] }
  if (mode === 'rejected') snapshot = new Error('Canonical read refused')
  if (mode === 'invalid-timeline') snapshot = { ...complete(), timelines: {} }
  await f.settle(snapshot)
  expect(useAppStore.getState().error).toBe(f.warning)
  expect(useAppStore.getState().lastError).toBe(f.warning)
  expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
  expect(element.querySelector('.error-notice')!.textContent).toContain(f.warning)
  f.retained()
})
it('does not let an unrelated Host warning hold this resolved notice', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), runtimeOwnershipWarnings: ['unrelated-host'] })
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().runtimeOwnershipWarnings).toEqual(['unrelated-host'])
  expect(useAppStore.getState().error).toBeNull()
  expect(element.querySelector('.error-notice')).toBeNull()
  f.retained()
})
it.each([false, true])('keeps other startup text and its dismissal (dismissed: %s)', async dismissed => {
  vi.mocked(api.providers.list).mockRejectedValue(new Error('Provider discovery unavailable'))
  vi.mocked(api.demands.list).mockRejectedValue(new Error('Demand filesystem unavailable'))
  const f = await fixture()
  const remainder = useAppStore.getState().errorNoticeContext!.startupSessionSnapshot!.remainingMessage
  expect(remainder).toContain('Provider discovery unavailable')
  expect(remainder).toContain('Demand filesystem unavailable')
  if (dismissed) await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  await f.settle(complete())
  expect(useAppStore.getState()).toMatchObject({ error: remainder, lastError: remainder, errorDismissed: dismissed })
  expect(element.querySelector('.error-notice') === null).toBe(dismissed)
  if (dismissed) {
    expect(element.querySelector('.error-notice__reopen')).not.toBeNull()
    await act(async () => element.querySelector<HTMLButtonElement>('.error-notice__reopen')!.click())
  }
  expect(element.querySelector('.error-notice')!.textContent).toContain(remainder)
  expect(element.querySelector('.error-notice')!.textContent).not.toContain('returned no Session facts')
  f.retained()
})
it.each(['same-text', 'different-text'] as const)('does not let the old read clear a later %s error', async mode => {
  const f = await fixture()
  const message = mode === 'same-text' ? f.warning : 'Later document save failed'
  await act(async () => useAppStore.getState().reportError(new Error(message), { kind: 'process-degraded' }))
  const laterContext = useAppStore.getState().errorNoticeContext
  expect(laterContext).toEqual({ kind: 'process-degraded' })
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().errorNoticeContext).toBe(laterContext)
  expect(useAppStore.getState()).toMatchObject({ error: message, lastError: message })
  expect(element.querySelector('.error-notice')!.textContent).toContain(message)
  f.retained()
})
it('removes the resolved last notice after the user dismissed it', async () => {
  const f = await fixture()
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  expect(element.querySelector('.error-notice__reopen')).not.toBeNull()
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null })
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  f.retained()
})
it.each([false, true])('a dismissed startup notice cannot swallow a later ordinary same-text error (explicit kind: %s)', async explicitKind => {
  const f = await fixture()
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  expect(element.querySelector('.error-notice__reopen')).not.toBeNull()
  await act(async () => useAppStore.getState().reportError(new Error(f.warning), explicitKind ? { kind: 'indeterminate' } : undefined))
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: f.warning, lastError: f.warning, errorDismissed: false })
  expect(element.querySelector('.error-notice')!.textContent).toContain(f.warning)
  f.retained()
})
