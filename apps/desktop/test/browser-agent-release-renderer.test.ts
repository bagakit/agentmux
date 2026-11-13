// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { reduceBrowserEvent } from '../src/renderer/src/lib/browser-state'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { createBrowserAgent } from '../src/renderer/src/lib/browser-agent-creation'
import { useAppStore } from '../src/renderer/src/store'

// Main clears a Browser's Agent association once Core confirms that Session retired. The Renderer
// then drops the creation request that made the association, so the Browser offers a new Agent
// instead of re-reading a finished request; nothing else forgets that request.

const agent = { hostId: 'original-host', agentSessionId: 'retired-agent' }
function surface(control: BrowserWorkbenchSurface['control']): BrowserWorkbenchSurface {
  return { regionId: 'region', browserId: 'browser', id: 'browser', kind: 'browser', mode: 'normal', workspaceId: 'workspace',
    navigationId: 'navigation', url: 'https://example.test/', title: 'Page', profileId: 'profile', driving: false, appLinkPrompt: null,
    loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null,
    agentCreationRequestId: 'finished-request', ...(control ? { control } : {}) }
}
const control = (association: typeof agent | null | undefined) =>
  ({ owner: 'human', revision: 3, activeOperationId: null, inputIsolation: 'inactive', ...(association === undefined ? {} : { agent: association }) }) as BrowserWorkbenchSurface['control']
function update(state: { tabs: Record<string, ReturnType<typeof createWorkbenchTab>> }, association: typeof agent | null | undefined) {
  const browser = { id: 'browser', mode: 'normal', navigationId: 'navigation', url: 'https://example.test/', title: 'Page', profileId: 'profile',
    driving: false, appLinkPrompt: null, loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null,
    control: { ...control(association)!, revision: 4 } } as BrowserSnapshot
  const next = reduceBrowserEvent(state as never, { type: 'updated', browser } as never) as typeof state
  return next.tabs.tab!.regions.region as BrowserWorkbenchSurface
}

describe('a released Browser association forgets its finished creation request', () => {
  it('drops the request when an Agent association becomes none', () => {
    const state = { tabs: { tab: createWorkbenchTab('tab', surface(control(agent))) } }
    const next = update(state, null)
    expect(next.control?.agent).toBeNull()
    expect(next).not.toHaveProperty('agentCreationRequestId')
  })

  for (const [name, before, after] of [
    ['the association is kept', agent, agent],
    ['the association was already none', null, null],
    ['the association becomes unconfirmed', agent, undefined],
    ['an unconfirmed association becomes none', undefined, null]
  ] as const) it(`keeps the request when ${name}`, () => {
    const state = { tabs: { tab: createWorkbenchTab('tab', surface(control(before))) } }
    expect(update(state, after).agentCreationRequestId).toBe('finished-request')
  })
})

describe('creating an Agent for a Browser with an old request', () => {
  const initial = useAppStore.getState()
  afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })
  const source = { tabId: 'tab', regionId: 'region', displayWorkspaceId: 'workspace', groupId: 'group' }
  function seed(association: typeof agent | null, request: { known: boolean; report: unknown } | 'unreadable') {
    const executeControl = vi.fn(async (input: { operation: string }) => {
      if (input.operation !== 'space.inspect') throw Object.assign(new Error('A new Agent was requested'), { code: 'NEW_AGENT_REQUESTED' })
      return request === 'unreadable' ? { operation: 'space.ls' } : { operation: 'space.inspect', catalog: {}, request: { requestId: 'finished-request', ...request } }
    })
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', surface(control(association))) }, config: undefined, executeControl } as never)
    return executeControl
  }

  it('starts a new Agent only when Core confirms the old request is gone and Main confirms no association', async () => {
    const executeControl = seed(null, { known: false, report: null })
    // Past the old request, the new-Agent path needs a Workspace; reaching that check proves the request was left behind.
    await expect(createBrowserAgent('browser', source)).rejects.toThrow('Workspace')
    expect(executeControl.mock.calls.map(call => (call[0] as { operation: string }).operation)).toEqual(['space.inspect'])
  })

  for (const [name, association, request] of [
    ['the old request may still be creating its Agent', null, { known: true, report: null }],
    ['the page still has an Agent association', agent, { known: false, report: null }],
    ['the old request cannot be read', null, 'unreadable']
  ] as const) it(`creates no second Agent when ${name}`, async () => {
    const executeControl = seed(association, request)
    await expect(createBrowserAgent('browser', source)).rejects.toThrow('no second Agent was created')
    expect(executeControl.mock.calls.map(call => (call[0] as { operation: string }).operation)).toEqual(['space.inspect'])
  })
})
