// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitWorkbenchRegion } from '@agentmux/layout'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { AgentSessionControl, SessionSnapshot } from '../src/shared/contracts'
import { BrowserOperationStatus, type BrowserAgentChoice } from '../src/renderer/src/components/BrowserOperationSurface'
import { browserAgentHandoffInput, browserAgentReturnInput, browserAgentLocations, browserAssociatedAgentSession, browserTabAgentSessions, browserTabAgentCandidates } from '../src/renderer/src/lib/browser-agent-handoff'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const a: AgentSessionControl = { kind: 'agent', hostId: 'host-a', agentSessionId: 'agent-a', run: { runId: 'run-a' } }
const b: AgentSessionControl = { kind: 'agent', hostId: 'host-b', agentSessionId: 'agent-b', run: { runId: 'run-b' } }
const control = (agent: AgentMuxBrowserControl['agent'], owner: AgentMuxBrowserControl['owner'] = 'human'): AgentMuxBrowserControl => ({
  owner, revision: 7, activeOperationId: null, inputIsolation: owner === 'agent' ? 'isolated' : 'inactive',
  ...(agent === undefined ? {} : { agent: agent ? { hostId: agent.hostId, agentSessionId: agent.agentSessionId } : null })
})
const page = (agent: AgentMuxBrowserControl['agent'] = null) => ({ browserId: 'page', navigationId: 'navigation', control: control(agent) })
const session = (id: string, original: AgentSessionControl): Extract<SessionSnapshot, { kind: 'agent' }> => ({
  id, kind: 'agent', hostId: original.hostId, control: original, label: id, providerId: 'codex', executorId: 'codex',
  processState: 'running', status: { state: 'unknown', source: 'process', observedAt: 1 }, workspacePath: '/project',
  createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, capabilities: {}
}) as Extract<SessionSnapshot, { kind: 'agent' }>
const choice = (original: AgentSessionControl, name: string): BrowserAgentChoice => ({ control: original, name, status: 'Observation unconfirmed', providerId: 'codex' })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

async function render(props: Partial<Parameters<typeof BrowserOperationStatus>[0]> = {}) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(BrowserOperationStatus, { activity: { operation: null, control: 'human' }, control: control(null), ...props })))
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  return host
}
async function open(button: HTMLElement) {
  await act(async () => { button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  return document.querySelector<HTMLElement>('[role="menu"]')!
}

describe('Browser Agent recipients use exact display membership and original identity', () => {
  it('selects only typed Regions in layout order, deduplicates one Session, and retains unknown activity', () => {
    const first = session('presentation-a', a), alias = session('another-a', a), second = session('presentation-b', b)
    const tab = createWorkbenchTab('tab', { kind: 'agent', phase: 'attached', sessionId: first.id, regionId: 'r-a', workspaceId: 'workspace' })
    tab.layout = splitWorkbenchRegion(tab.layout, 'r-a', 'right', 'r-alias')
    tab.layout = splitWorkbenchRegion(tab.layout, 'r-alias', 'right', 'r-b')
    tab.regions['r-alias'] = { kind: 'agent', phase: 'attached', sessionId: alias.id, regionId: 'r-alias', workspaceId: 'workspace' }
    tab.regions['r-b'] = { kind: 'agent', phase: 'attached', sessionId: second.id, regionId: 'r-b', workspaceId: 'workspace' }
    tab.regions['unbound-record'] = { kind: 'agent', phase: 'attached', sessionId: 'outside', regionId: 'unbound-record', workspaceId: 'workspace' }
    expect(browserTabAgentSessions(tab, [first, alias, second, session('outside', { ...b, agentSessionId: 'outside' })])).toEqual([first, second])
    expect(browserTabAgentSessions(undefined, [first, second])).toEqual([])
  })

  it('never selects an alias or another Host to fill an ambiguous associated Session', () => {
    const first = session('presentation-a', a), otherHost = session('remote-a', { ...a, hostId: 'other-host' })
    expect(browserAssociatedAgentSession(a, [otherHost, first])).toBe(first)
    expect(browserAssociatedAgentSession(a, [first, session('alias-a', a)])).toBeUndefined()
    expect(browserAssociatedAgentSession(undefined, [first])).toBeUndefined()
    expect(browserAssociatedAgentSession(null, [first])).toBeUndefined()
  })

  it('does not report an empty Tab when its original Agent observation is missing', () => {
    const tab = createWorkbenchTab('tab', { kind: 'agent', phase: 'attached', sessionId: 'retained-agent', regionId: 'retained-region', workspaceId: 'workspace' })
    expect(browserTabAgentCandidates(tab, [])).toEqual({ sessions: [], unconfirmed: true })
    expect(browserTabAgentCandidates(undefined, [])).toEqual({ sessions: [], unconfirmed: true })
  })

  it('fences new and replacement handoffs to the page, revision and original association', () => {
    expect(browserAgentHandoffInput(page(), page(), a)).toEqual({ navigationId: 'navigation', expectedRevision: 7, agent: a })
    expect(browserAgentHandoffInput(page(a), page(a), b)).toEqual({ navigationId: 'navigation', expectedRevision: 7, expectedAgent: { hostId: a.hostId, agentSessionId: a.agentSessionId }, agent: b })
    const observed = page(a)
    for (const changed of [page(b), { ...page(a), navigationId: 'new-document' }, { ...page(a), control: { ...control(a), revision: 8 } }]) {
      expect(() => browserAgentHandoffInput(observed, changed, b)).toThrow('changed')
    }
    const unconfirmed = { ...page(), control: control(undefined) }
    expect(browserAgentHandoffInput(unconfirmed, unconfirmed, a)).toEqual({ navigationId: 'navigation', expectedRevision: 7, expectedAgent: 'unknown', agent: a })
    expect(() => browserAgentHandoffInput(unconfirmed, page(), a)).toThrow('changed')
  })

  it('returns to the retained Host/Session without manufacturing a new Run grant', () => {
    const result = browserAgentReturnInput(page(a), page(a))
    expect(result).toEqual({ navigationId: 'navigation', expectedRevision: 7, expectedAgent: { hostId: a.hostId, agentSessionId: a.agentSessionId } })
    expect(result).not.toHaveProperty('agent')
    expect(() => browserAgentReturnInput(page(a), page(b))).toThrow('linked Agent changed')
  })

  it('retains every original workface occurrence and excludes the same SID on another Host', () => {
    const catalog = { regions: [
      { kind: 'agent', tabId: 't-a', regionId: 'r-a', agentSessionId: a.agentSessionId, execution: { hostId: a.hostId } },
      { kind: 'agent', tabId: 't-b', regionId: 'r-b', agentSessionId: a.agentSessionId, execution: { hostId: 'other-host' } }
    ], locations: [
      { displayWorkspaceId: 'display', groupId: 'one', tabId: 't-a', regionId: 'r-a' },
      { displayWorkspaceId: 'display', groupId: 'two', tabId: 't-a', regionId: 'r-a' },
      { displayWorkspaceId: 'display', groupId: 'three', tabId: 't-b', regionId: 'r-b' }
    ] } as unknown as AgentMuxSpaceCatalog
    expect(browserAgentLocations(catalog, a)).toEqual(catalog.locations.slice(0, 2))
  })
})

describe('Browser control chooses an existing collaborator before creation', () => {
  it('keeps explicit creation as the direct action when no Agent is present', async () => {
    const create = vi.fn(), give = vi.fn(), host = await render({ onCreateAgent: create, onGiveControl: give, agents: [] })
    const button = host.querySelector<HTMLButtonElement>('[aria-label="在右侧创建 Agent"]')!
    expect(button).not.toBeNull(); await act(async () => button.click())
    expect(create).toHaveBeenCalledOnce(); expect(give).not.toHaveBeenCalled()
  })

  it('gives a single exact Agent control without creating or sending a task', async () => {
    const create = vi.fn(), give = vi.fn(), host = await render({ onCreateAgent: create, onGiveControl: give, agents: [choice(a, 'Atlas')] })
    expect(host.querySelector('[aria-label="在右侧创建 Agent"]')).toBeNull()
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Give to Atlas"]')!
    expect(button).not.toBeNull(); await act(async () => button.click())
    expect(give).toHaveBeenCalledExactlyOnceWith(a); expect(create).not.toHaveBeenCalled()
    const menu = await open(host.querySelector('[aria-label^="Browser activity:"]')!)
    expect(menu.textContent).toContain('在右侧创建 Agent')
  })

  it('requires a choice with multiple Agents instead of choosing the first or most active one', async () => {
    const give = vi.fn(), host = await render({ onGiveControl: give, agents: [choice(a, 'Atlas'), choice(b, 'Boreal')] })
    expect(give).not.toHaveBeenCalled()
    const menu = await open(host.querySelector('[aria-label="Choose Agent…"]')!)
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
    await act(async () => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))[1]!.click())
    expect(give).toHaveBeenCalledExactlyOnceWith(b)
  })

  it('keeps unobserved Agent membership explicit while retaining the choice to create', async () => {
    const create = vi.fn(), give = vi.fn(), host = await render({ onGiveControl: give, onCreateAgent: create, candidatesUnconfirmed: true, agents: [] })
    expect(host.querySelector('[aria-label="在右侧创建 Agent"]')).toBeNull()
    const menu = await open(host.querySelector('[aria-label="Choose Agent…"]')!)
    expect(menu.textContent).toContain('Some Agent identities are not yet confirmed')
    const action = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === '在右侧创建 Agent')!
    await act(async () => action.click()); expect(create).toHaveBeenCalledOnce(); expect(give).not.toHaveBeenCalled()
  })

  it('shows actual operator B beside the action while keeping associated A as the return target', async () => {
    const resume = vi.fn(), give = vi.fn(), host = await render({ control: control(a), associatedAgent: choice(a, 'Atlas'), agents: [choice(a, 'Atlas'), choice(b, 'Boreal')],
      onReturnControl: resume, onGiveControl: give, activity: { control: 'agent', operation: { id: 'operation-b', browserId: 'page',
        operator: { id: b.agentSessionId, name: 'Boreal' }, phase: 'completed', startedAt: 1, finishedAt: 2, summary: 'Observed', steps: [], url: 'https://example.test/' } } })
    expect(host.querySelector('.browser-operation-status__agent')?.textContent).toBe('Boreal')
    expect(host.querySelector('[aria-label^="Browser activity:"]')?.getAttribute('title')).toContain('Linked Agent: Atlas')
    const menu = await open(host.querySelector('[aria-label^="Browser activity:"]')!)
    expect(menu.textContent).toContain('Operation by Boreal'); expect(menu.textContent).toContain('Switch to Boreal')
    expect(menu.textContent).toContain('Linked to Atlas')
    expect(menu.textContent).not.toContain('Switch to Atlas')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Return to Atlas"]')!.click())
    expect(resume).toHaveBeenCalledOnce(); expect(give).not.toHaveBeenCalled()
  })

  it('explains unknown association and retains explicit takeover without suggesting creation', async () => {
    const check = vi.fn(), take = vi.fn(), host = await render({ control: control(undefined, 'agent'), onRefreshControl: check, onTakeControl: take,
      onCreateAgent: vi.fn(), onGiveControl: vi.fn(), agents: [choice(a, 'Atlas')] })
    expect(host.querySelector('[aria-label="Take control of Browser"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Give to Atlas"]')).toBeNull()
    expect(host.querySelector('[aria-label="在右侧创建 Agent"]')).toBeNull()
    const menu = await open(host.querySelector('[aria-label^="Browser activity:"]')!)
    expect(menu.textContent).toContain('Agent association unconfirmed')
    const action = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === 'Check Agent association')!
    await act(async () => action.click()); expect(check).toHaveBeenCalledOnce()
  })

  it('lets the person explicitly confirm an unknown association without guessing the sole candidate', async () => {
    const give = vi.fn(), host = await render({ control: control(undefined), onGiveControl: give, onCreateAgent: vi.fn(), agents: [choice(a, 'Atlas')] })
    expect(host.querySelector('[aria-label="Give to Atlas"]')).toBeNull()
    expect(host.querySelector('[aria-label="在右侧创建 Agent"]')).toBeNull()
    expect(give).not.toHaveBeenCalled()
    const menu = await open(host.querySelector('[aria-label="Choose Agent…"]')!)
    expect(menu.textContent).toContain('Select an Agent explicitly')
    const action = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.includes('Atlas'))!
    await act(async () => action.click()); expect(give).toHaveBeenCalledExactlyOnceWith(a)
  })
})
