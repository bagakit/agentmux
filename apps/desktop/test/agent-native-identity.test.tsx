// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as Menu from '../src/renderer/src/components/HoverDropdownMenu'
import { AgentMenuIdentityActions } from '../src/renderer/src/components/AgentMenuIdentityActions'
import { ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { RegionContextMenu } from '../src/renderer/src/components/RegionContextMenu'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => <span />
}))

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const dom = composerDOM()
const target = (provider = 'codex'): Agent => ({ ...composerSession('presentation-alias', provider),
  control: { kind: 'agent', hostId: 'remote-private-host', agentSessionId: 'canonical-agent', run: { runId: 'original-run' } },
  hostId: 'remote-private-host', nativeHandle: { kind: 'provider', providerId: provider,
    sessionId: provider === 'codex' ? '01977e0b-55fd-7a6c-a901-private-native' : 'native_conversation_alpha' },
  observedNativeHandle: { kind: 'provider', providerId: provider, sessionId: 'unadopted-observed-candidate' } })
const links = [{ label: 'Copy Agent Link', icon: <span aria-hidden>Agent</span>, onSelect: vi.fn() },
  { label: 'Copy Region Link', icon: <span aria-hidden>Region</span>, onSelect: vi.fn() }]
const nativeButton = () => document.querySelector<HTMLElement>('[data-native-session-copy]')!
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
async function mount(session: Agent | null, providerId = session?.providerId, badge = false) {
  const config = badge ? { ...composerConfig, executors: { ...composerConfig.executors,
    codex: { ...composerConfig.executors.codex!, avatar: { badge: 'bolt' as const, tint: '#8ab4f8' } } } } : composerConfig
  await dom.render(<ExecutorIdentityContext.Provider value={{ config }}>
    <Menu.Root open><Menu.Trigger>Original Agent actions</Menu.Trigger><Menu.Content>
      <AgentMenuIdentityActions links={links} session={session} providerId={providerId} executorId={session?.executorId}
        executorLabel={providerId === 'claude' ? 'Claude' : 'Codex'} Item={Menu.Item} Group={Menu.Group} Label={Menu.Label} />
    </Menu.Content></Menu.Root>
  </ExecutorIdentityContext.Provider>)
}
beforeEach(() => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  links.forEach(action => action.onSelect.mockClear())
})

it.each(['codex', 'claude'])('copies the adopted %s native ID verbatim, separately from links, aliases, Run and candidate', async provider => {
  const session = target(provider)
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Keep original draft' } })
  const before = useAppStore.getState()
  await mount(session)
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  expect(items.map(node => node.getAttribute('aria-label'))).toEqual(['Copy Agent Link', `Copy ${provider === 'claude' ? 'Claude' : 'Codex'} native Session ID`, 'Copy Region Link'])
  expect(document.querySelectorAll('[data-native-session-copy]')).toHaveLength(1)
  await act(async () => nativeButton().click()); await settle()
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(session.nativeHandle!.sessionId)
  expect(links.every(action => action.onSelect.mock.calls.length === 0)).toBe(true)
  const after = useAppStore.getState()
  for (const key of ['sessions', 'agentComposerDrafts', 'tabs', 'layouts', 'agentFocus'] as const) expect(after[key]).toBe(before[key])
})

it('keeps an adopted ID readable despite unobserved Run and native source observation gaps', async () => {
  const session = { ...target(), runUnobserved: true, nativeSourceObservation: { state: 'unknown' as const,
    run: { runId: 'original-run' }, source: 'provider' as const, observedAt: 1 } } as Agent
  await mount(session)
  await act(async () => nativeButton().click()); await settle()
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(session.nativeHandle!.sessionId)
})

it('copies the Core-adopted ACP native identity in its own namespace', async () => {
  const session: Agent = { ...target('acp-provider'), nativeHandle: { kind: 'acp', adapterId: 'private-adapter', sessionId: 'acp-native-session-alpha' } }
  await mount(session)
  await act(async () => nativeButton().click()); await settle()
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith('acp-native-session-alpha')
})

it.each(['absent', 'wrong-provider', 'wrong-kind', 'empty'] as const)('reports %s identity only for this copy without writing substitute text', async mode => {
  let session: Agent | null = target()
  if (mode === 'absent') session = { ...session, nativeHandle: undefined } as Agent
  if (mode === 'empty') session = { ...session, nativeHandle: { ...session.nativeHandle!, sessionId: '' } }
  if (mode === 'wrong-kind') session = { ...session, nativeHandle: { kind: 'unknown', providerId: 'codex', sessionId: 'wrong-kind-value' } } as unknown as Agent
  await mount(session, mode === 'wrong-provider' ? 'claude' : 'codex')
  const before = useAppStore.getState()
  await act(async () => nativeButton().click()); await settle()
  expect(api.ui.writeClipboardText).not.toHaveBeenCalled()
  expect(useAppStore.getState().error).toContain('not confirmed')
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(session.control)
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain('Check native source')
  for (const key of ['sessions', 'agentComposerDrafts', 'tabs', 'layouts'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('uses the shared configured Executor artwork without mounting its disclosure or adding Store listeners', async () => {
  const subscribe = vi.spyOn(useAppStore, 'subscribe')
  await mount(target(), 'codex', true)
  expect(subscribe).not.toHaveBeenCalled()
  expect(nativeButton().querySelector('[data-executor-id="codex"]')).not.toBeNull()
  expect(nativeButton().querySelector('[data-avatar-badge="bolt"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Executor details"]')).toBeNull()
  await act(async () => nativeButton().focus()); await settle()
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Copy Codex native Session ID')
})

it('reports a late clipboard failure on the original canonical subject after its menu unmounts', async () => {
  let reject!: (error: Error) => void
  vi.mocked(api.ui.writeClipboardText).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const session = target()
  await mount(session)
  await act(async () => nativeButton().click())
  await dom.render(<div>Later work surface</div>)
  await act(async () => reject(new Error('Original clipboard operation denied'))); await settle()
  expect(useAppStore.getState().error).toContain('Original clipboard operation denied')
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(session.control)
})

it('the original Region Header consumes the shared avatar copy even for a read-only observation', async () => {
  const session = target()
  useAppStore.setState({ sessions: [session] })
  await dom.render(<RegionContextMenu tabId="original-tab" regionId="original-region" agentSessionId="canonical-agent" writeClipboardText={vi.fn()}>
    <AgentRegionHeader name="Original Agent" executorLabel="Codex" sessionId={session.id} sessionKind="agent"
      executionHost={{ id: session.hostId, label: 'Private remote', kind: 'ssh', configured: true, cwd: session.workspacePath }}
      regionId="original-region" readOnly onHistory={undefined} nativeSession={session} />
  </RegionContextMenu>)
  const trigger = dom.container.querySelector('[aria-label^="More actions"]')!
  await act(async () => { (trigger as HTMLElement).focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) }); await settle()
  expect(nativeButton()).not.toBeNull()
  await act(async () => nativeButton().click()); await settle()
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(session.nativeHandle!.sessionId)
})

it('the real Focus card copies its own native ID while a same-name neighbor is selected', async () => {
  const session = target(), neighbor = { ...target(), id: 'neighbor-alias', hostId: 'other-host',
    control: { ...session.control, hostId: 'other-host', agentSessionId: 'neighbor-canonical' },
    nativeHandle: { ...session.nativeHandle!, sessionId: 'neighbor-native' } }
  const select = vi.fn(), focus = useAppStore.getState().agentFocus
  useAppStore.setState({ sessions: [neighbor, session], agentFocus: { ...focus, execution: { ...focus.execution, sessionId: neighbor.id } } })
  const before = useAppStore.getState()
  await dom.render(<FocusContextRow context={agentContextForSession(session, undefined, 'Same Agent')} selected={false} onSelect={select} />)
  const card = dom.container.querySelector('button[data-session-id]')!
  await act(async () => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }))); await settle()
  expect(nativeButton()).not.toBeNull()
  await act(async () => nativeButton().click()); await settle()
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(session.nativeHandle!.sessionId)
  expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
