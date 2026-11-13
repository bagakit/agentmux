// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { MoteDialogueViewContext } from '../src/renderer/src/lib/mote-dialogue-view'
import { MoteWorkfaceContext } from '../src/renderer/src/lib/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { moteAgent, seedMoteWorkface } from './fixtures/mote-workface'

/**
 * A message the person sent while a Mote's Main was being read is handed to that Main's own Composer only after the
 * role owner confirms it. The Composer sends it once through the ordinary send, bound to the confirmed role, and
 * never to another Session that happens to be mounted.
 */
const closes: Array<() => unknown | Promise<unknown>> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const prior = useAppStore.getState(), dispose = await useAppStore.getState().initialize(); dispose?.()
  closes.push(() => useAppStore.setState(prior, true)); seedMoteWorkface()
})
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const main = moteAgent('held-main', null, 'waiting'), other = moteAgent('held-other', null, 'waiting')
const target = { spaceId: 'mote-space', zoneId: 'mote-zone', expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: '/scratch' } }
const role = { status: 'ready', roleRevision: 'role-1', current: { hostId: main.control.hostId, sessionId: main.control.agentSessionId } }

async function mount(sessionId: string, accepted = true) {
  useAppStore.setState({ sessions: [main, other] })
  const send = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(accepted)
  const settle = vi.fn()
  const workface = { section: 'discussion', heldInput: { operationId: 'held-op', prompt: '读取中写下的问题' },
    settleHeldInput: settle } as never
  const dialogue = { target, page: { main: role } } as never
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  const node = (visible: boolean) => <DesktopClientUiProvider><MoteDialogueViewContext.Provider value={dialogue}><MoteWorkfaceContext.Provider value={workface}>
    <AgentSessionComposer sessionId={sessionId} visible={visible} /></MoteWorkfaceContext.Provider></MoteDialogueViewContext.Provider></DesktopClientUiProvider>
  await act(async () => root.render(node(true)))
  return { send, settle, rerender: async (visible = true) => { await act(async () => root.render(node(visible))) } }
}

it('the confirmed Main sends the held message once, bound to its confirmed role', async () => {
  const m = await mount(main.id)
  await vi.waitFor(() => expect(m.send).toHaveBeenCalledOnce())
  expect(m.send.mock.calls[0]![1]).toBe('读取中写下的问题')
  expect(m.send.mock.calls[0]![5]).toMatchObject({ moteMain: { target, expectedRoleRevision: 'role-1' } })
  expect(m.settle).toHaveBeenCalledWith('held-op', true)
  // The workface may still offer the same message until its hold settles; hiding and showing the Composer meanwhile does not resend it.
  await m.rerender(false); await m.rerender(true)
  expect(m.send).toHaveBeenCalledOnce()
})

it('a held message for one Main is never sent by another Session on the same Host', async () => {
  const m = await mount(other.id)
  await act(async () => {})
  expect(m.send).not.toHaveBeenCalled(); expect(m.settle).not.toHaveBeenCalled()
})

it('a refused send ends the hold as not accepted, so its draft is kept', async () => {
  const m = await mount(main.id, false)
  await vi.waitFor(() => expect(m.settle).toHaveBeenCalledWith('held-op', false))
  expect(m.send).toHaveBeenCalledOnce()
})

it('a hold saved by an open that no longer exists returns to the draft instead of being sent', async () => {
  const { useLauncherState } = await import('../src/renderer/src/lib/launcher-state')
  const { useMoteHeldEntryInput } = await import('../src/renderer/src/lib/mote-entry-hold')
  const key = 'mote-main-start:stale-hold'
  useLauncherState.getState().setDraft(key, 'prompt', 'Earlier open')
  useLauncherState.getState().holdPrompt(key, 'stale-op', 'closed-window-open')
  expect(useLauncherState.getState().drafts[key]?.heldPrompt?.operationId).toBe('stale-op')
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  let seen: ReturnType<typeof useMoteHeldEntryInput> | undefined
  function Probe() { seen = useMoteHeldEntryInput(key, true); return null }
  await act(async () => root.render(<Probe />))
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  expect(seen!.held).toBeNull()
  expect(useLauncherState.getState().drafts[key]).toMatchObject({ prompt: 'Earlier open' })
  expect(useLauncherState.getState().drafts[key]?.heldPrompt).toBeUndefined()
})

it('hiding the open that held a message returns it to the draft', async () => {
  const { useLauncherState } = await import('../src/renderer/src/lib/launcher-state')
  const { useMoteHeldEntryInput } = await import('../src/renderer/src/lib/mote-entry-hold')
  const key = 'mote-main-start:hidden-hold'
  useLauncherState.getState().setDraft(key, 'prompt', 'Typed while reading')
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  let seen: ReturnType<typeof useMoteHeldEntryInput> | undefined
  function Probe({ active }: { active: boolean }) { seen = useMoteHeldEntryInput(key, active); return null }
  await act(async () => root.render(<Probe active />))
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => seen!.hold())
  expect(seen!.held?.prompt).toBe('Typed while reading')
  expect(useLauncherState.getState().drafts[key]?.prompt).toBe('')
  await act(async () => root.render(<Probe active={false} />))
  expect(useLauncherState.getState().drafts[key]).toMatchObject({ prompt: 'Typed while reading' })
  expect(useLauncherState.getState().drafts[key]?.heldPrompt).toBeUndefined()
})
