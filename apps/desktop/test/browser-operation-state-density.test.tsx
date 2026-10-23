import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import type { BrowserActivityState, BrowserOperation, BrowserOperationPhase } from '../src/shared/browser-operation'
import { BrowserOperationStatus, BrowserOperationTimeline, BrowserOperationWarning } from '../src/renderer/src/components/BrowserOperationSurface'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const operation: BrowserOperation = {
  id: 'observed-operation', browserId: 'browser', operator: { id: 'operator', name: 'Navigator' },
  startedAt: _hygiene_fixtureTime(-67225600000), phase: 'running', summary: 'Review settings', url: 'https://example.test',
  steps: [{ sequence: 1, method: 'click', label: 'Open settings', startedAt: _hygiene_fixtureTime(-67225599900),
    status: 'running', target: { role: 'button', name: 'Settings', ordinal: 1, count: 1 } }]
}

const currentControl = (owner: AgentMuxBrowserControl['owner'], activeOperationId: string | null = null): AgentMuxBrowserControl => ({
  owner, activeOperationId, revision: 3, inputIsolation: owner === 'agent' ? 'isolated' : owner === 'human' ? 'inactive' : 'unconfirmed',
  agent: { hostId: 'local', agentSessionId: operation.operator.id }
})
type StatusProps = Parameters<typeof BrowserOperationStatus>[0]
type Handlers = Pick<StatusProps, 'onStop' | 'onTakeControl' | 'onReturnControl' | 'onOpenTimeline'>
async function renderStatus(activity: BrowserActivityState, control: AgentMuxBrowserControl | undefined, handlers: Handlers = {}, browserId = operation.browserId) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(BrowserOperationStatus, { activity, browserId, control, ...handlers })))
  return { host, root, trigger: host.querySelector<HTMLButtonElement>('[aria-label^="Browser activity:"]')!,
    async close() { await act(async () => root.unmount()); host.remove() } }
}

describe('Browser operation status in existing controls', () => {
  it('renders four nonempty observed states with distinct glyphs and accessible facts', async () => {
    const cases: [BrowserOperationPhase, AgentMuxBrowserControl['owner'], string, string, string][] = [
      ['running', 'agent', 'Operating page', '[data-semantic-icon="status.browser-running"]', 'Operating'],
      ['waiting', 'agent', 'Waiting for page', '[data-semantic-icon="status.waiting"]', 'Waiting'],
      ['human', 'human', 'Human has control', '[data-semantic-icon="object.user"]', 'Your turn'],
      ['failed', 'human', 'Failed', '[data-semantic-icon="status.failed"]', 'Failed']
    ]
    expect(cases.map(([phase]) => phase)).toEqual(['running', 'waiting', 'human', 'failed'])
    for (const [phase, owner, label, glyph, cue] of cases) {
      const view = await renderStatus({ operation: { ...operation, phase }, control: owner === 'agent' ? 'agent' : 'human' },
        currentControl(owner, owner === 'agent' ? operation.id : null))
      try {
        expect(view.host.querySelector('.browser-operation-status')!.getAttribute('data-phase')).toBe(phase)
        for (const fact of ['Navigator', label, 'button “Settings”']) expect(view.trigger.getAttribute('aria-label')).toContain(fact)
        expect(view.trigger.getAttribute('title')).toContain(label)
        expect(view.trigger.querySelector(glyph), phase).not.toBeNull()
        expect(view.host.querySelectorAll('button')).toHaveLength(1)
        expect(document.querySelector('.browser-operation-menu')).toBeNull()
        expect(view.host.querySelector('.browser-operation-status__cue')?.textContent).toBe(cue)
      } finally { await view.close() }
    }
  })

  it('uses control ownership before a nonterminal phase projection catches up, and never calls unknown healthy', async () => {
    const human = await renderStatus({ operation, control: 'agent' }, currentControl('human'))
    try {
      expect(human.trigger.getAttribute('aria-label')).toContain('Human has control')
      expect(human.trigger.querySelector('[data-semantic-icon="object.user"]')).not.toBeNull()
    } finally { await human.close() }
    const unknown = await renderStatus({ operation: null, control: 'human' }, currentControl('agent', operation.id))
    try {
      expect(unknown.host.querySelector('.browser-operation-status')!.getAttribute('data-phase')).toBe('unknown')
      expect(unknown.trigger.getAttribute('aria-label')).toContain('Activity details are loading')
      expect(unknown.trigger.querySelector('[data-semantic-icon="status.warning"]')).not.toBeNull()
      expect(unknown.trigger.getAttribute('aria-label')).not.toContain('Completed')
    } finally { await unknown.close() }
  })

  it.each(['absent', 'unknown', 'different-operation', 'different-browser'] as const)('does not borrow handoff or busy authority from historical control when current control is %s', async source => {
    const take = vi.fn(), resume = vi.fn()
    const retained = { ...operation, control: currentControl('human') }
    const control = source === 'absent' ? undefined : source === 'unknown' ? currentControl('unknown')
      : currentControl('agent', source === 'different-operation' ? 'other-operation' : operation.id)
    const view = await renderStatus({ operation: retained, control: 'human' }, control,
      { onTakeControl: take, onReturnControl: resume }, source === 'different-browser' ? 'other-browser' : operation.browserId)
    try {
      expect(view.host.querySelector('[aria-label="Return to Agent"]')).toBeNull()
      expect(view.host.querySelector('[data-icon-animation="execute"],[data-icon-animation="wait"],[data-icon-animation="spin"]')).toBeNull()
      const agent = control?.owner === 'agent'
      expect(Boolean(view.host.querySelector('[aria-label="Take control of Browser"]'))).toBe(agent)
      if (agent) {
        expect(view.host.querySelector('.browser-operation-status')!.getAttribute('data-phase')).toBe('unknown')
        expect(view.trigger.getAttribute('aria-label')).toContain('Activity details are loading')
      }
      expect(take).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
    } finally { await view.close() }
  })

  it('opens actions on hover and invokes the actual stop callback with keyboard selection', async () => {
    const stop = vi.fn(), take = vi.fn(), history = vi.fn()
    const view = await renderStatus({ operation, control: 'human' }, currentControl('agent', operation.id),
      { onStop: stop, onTakeControl: take, onOpenTimeline: history })
    try {
      expect(document.querySelector('[aria-label="Stop browser operation"]')).toBeNull()
      await act(async () => view.trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
      const menu = document.querySelector('.browser-operation-menu')!
      expect(menu).not.toBeNull()
      expect(view.trigger.getAttribute('aria-expanded')).toBe('true')
      expect(menu.textContent).toContain('Navigator')
      expect(menu.textContent).toContain('Take control')
      expect(menu.textContent).toContain('button “Settings”')
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      expect(items.map(item => item.textContent)).toEqual(['Take control', 'Stop operation', 'Activity'])
      const action = menu.querySelector<HTMLElement>('[aria-label="Stop browser operation"]')!
      await act(async () => { action.focus(); action.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(stop).toHaveBeenCalledExactlyOnceWith()
      expect(take).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
    } finally { await view.close() }
  })

  it.each(['running', 'human'] as const)('opens with keyboard and keeps Return separate from Stop on an active %s operation', async (phase) => {
    const resume = vi.fn(), stop = vi.fn()
    const view = await renderStatus({ operation: { ...operation, phase }, control: 'agent' }, currentControl('human'),
      { onReturnControl: resume, onStop: stop })
    try {
      await act(async () => { view.trigger.focus(); view.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      const menu = document.querySelector('.browser-operation-menu')!
      expect(menu).not.toBeNull()
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      expect(items.map(item => item.textContent)).toEqual(['Return to Agent', 'Stop operation'])
      await act(async () => items[0]!.click())
      expect(resume).toHaveBeenCalledExactlyOnceWith()
      expect(stop).not.toHaveBeenCalled()
    } finally { await view.close() }
  })

  it.each(['completed', 'failed', 'stopped', 'indeterminate', null] as const)('keeps Return reachable with human control after %s', async (phase) => {
    const resume = vi.fn(), stop = vi.fn(), take = vi.fn()
    const activity: BrowserActivityState = { operation: phase ? { ...operation, phase, finishedAt: _hygiene_fixtureTime(-67225599800) } : null, control: 'human' }
    const original = structuredClone(activity)
    const view = await renderStatus(activity, currentControl('human'),
      { onReturnControl: resume, onStop: stop, onTakeControl: take, onOpenTimeline: vi.fn() })
    try {
      await act(async () => { view.trigger.focus(); view.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      const items = Array.from(document.querySelectorAll<HTMLElement>('.browser-operation-menu [role="menuitem"]'))
      expect(items.map(item => item.textContent)).toEqual(['Return to Agent', 'Activity'])
      expect(view.host.querySelector('.browser-operation-status')!.getAttribute('data-phase')).toBe(phase ?? 'idle')
      const label = phase === null ? 'You have control' : phase === 'completed' ? 'Completed' : phase === 'failed' ? 'Failed' : phase === 'stopped' ? 'Stopped' : 'Needs review'
      expect(view.trigger.getAttribute('aria-label')).toContain(label)
      await act(async () => { items[0]!.focus(); items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(resume).toHaveBeenCalledExactlyOnceWith()
      expect(stop).not.toHaveBeenCalled()
      expect(take).not.toHaveBeenCalled()
      expect(activity).toEqual(original)
    } finally { await view.close() }
  })

  it.each(['completed', 'failed', 'stopped', 'indeterminate', null] as const)('keeps Take reachable without Return or Stop while Agent retains control after %s', async (phase) => {
    const resume = vi.fn(), stop = vi.fn(), take = vi.fn()
    const view = await renderStatus({ operation: phase ? { ...operation, phase } : null, control: 'human' }, currentControl('agent'),
      { onReturnControl: resume, onStop: stop, onTakeControl: take, onOpenTimeline: vi.fn() })
    try {
      await act(async () => view.trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
      const items = Array.from(document.querySelectorAll<HTMLElement>('.browser-operation-menu [role="menuitem"]'))
      expect(items.map(item => item.textContent)).toEqual(['Take control', 'Activity'])
      expect(view.trigger.getAttribute('aria-label')).toContain(phase ? 'Agent retains control' : 'Agent has control')
      await act(async () => items[0]!.click())
      expect(resume).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      expect(take).toHaveBeenCalledExactlyOnceWith()
    } finally { await view.close() }
  })

  it.each(['running', 'completed', null] as const)('keeps both direct handoff paths focusable without opening a menu for %s', async phase => {
    for (const owner of ['agent', 'human'] as const) {
      const take = vi.fn(), resume = vi.fn(), stop = vi.fn(), history = vi.fn()
      const view = await renderStatus({ operation: phase ? { ...operation, phase } : null, control: owner === 'agent' ? 'human' : 'agent' },
        currentControl(owner, owner === 'agent' && phase === 'running' ? operation.id : null),
        { onTakeControl: take, onReturnControl: resume, onStop: stop, onOpenTimeline: history })
      try {
        const direct = view.host.querySelector<HTMLButtonElement>(owner === 'agent' ? '[aria-label="Take control of Browser"]' : '[aria-label="Return to Agent"]')
        expect(direct).not.toBeNull(); expect(direct!.disabled).toBe(false); expect(direct!.tabIndex).toBe(0)
        await act(async () => { direct!.focus(); direct!.click() })
        expect(document.activeElement).toBe(direct)
        expect(owner === 'agent' ? take : resume).toHaveBeenCalledExactlyOnceWith()
        expect(owner === 'agent' ? resume : take).not.toHaveBeenCalled()
        expect(stop).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
        expect(document.querySelector('.browser-operation-menu')).toBeNull()
      } finally { await view.close() }
    }
  })

  it('keeps the reported failure and recovery line persistent while raw diagnostics mount only on demand', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const warning = 'The result is unknown. Inspect the page before retrying.\n    at private diagnostic frame'
    try {
      await act(async () => root.render(createElement(BrowserOperationWarning, { activity: { operation: { ...operation, phase: 'failed', warning }, control: 'human', warning } })))
      expect(host.querySelector('[role="status"]')!.textContent).toContain(warning.split('\n')[0])
      expect(host.textContent).not.toContain('private diagnostic frame')
      const details = host.querySelector<HTMLButtonElement>('[aria-label="Show browser warning details"]')!
      await act(async () => details.click())
      expect(host.querySelector('pre')!.textContent).toBe(warning)
      await act(async () => details.click())
      expect(host.querySelector('pre')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps a resolved incident in history while current notices follow the Main activity projection', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const warning = 'Native input isolation was unconfirmed during this operation.'
    const historical = { ...operation, phase: 'completed' as const, warning }
    const render = (currentWarning?: string) => root.render(createElement('div', null,
      createElement(BrowserOperationWarning, { activity: { operation: historical, control: 'agent', ...(currentWarning ? { warning: currentWarning } : {}) } }),
      createElement(BrowserOperationTimeline, { operation: historical })))
    try {
      await act(async () => render(warning))
      expect(host.querySelector('.browser-operation-warning')!.textContent).toContain(warning)
      await act(async () => render())
      expect(host.querySelector('.browser-operation-warning')).toBeNull()
      expect(host.querySelector('.browser-rsi-timeline__warning')!.textContent).toContain(warning)
      const unrelated = 'Step evidence could not be saved. Inspect local storage.'
      await act(async () => render(unrelated))
      expect(host.querySelector('.browser-operation-warning')!.textContent).toContain(unrelated)
      expect(host.querySelector('.browser-rsi-timeline__warning')!.textContent).toContain(warning)
      expect(historical.warning).toBe(warning)
    } finally { await act(async () => root.unmount()) }
  })

  it('mounts the actual presence consumer with current control and trusted actions inside the original toolbar', () => {
    const text = readFileSync(resolve(__dirname, '../src/renderer/src/components/BrowserPane.tsx'), 'utf8')
    const source = ts.createSourceFile('BrowserPane.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const status: ts.JsxSelfClosingElement[] = [], warnings: ts.JsxSelfClosingElement[] = []
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'BrowserOperatorPresence') status.push(node)
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'BrowserOperationWarning') warnings.push(node)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(status).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    const props = Object.fromEntries(status[0]!.attributes.properties.filter(ts.isJsxAttribute).map(attribute =>
      [attribute.name.getText(source), attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression?.getText(source) : undefined]))
    expect(props).toMatchObject({ activity: 'browserActivity', control: 'tab.control', browserId: 'tab.browserId',
      onTakeControl: '() => void takeBrowserControl()', onStop: '() => void stopBrowserOperation()',
      onReturnControl: '() => void run(() => api.browser.returnControl(tab.browserId))' })
    let ancestor: ts.Node | undefined = status[0]!.parent
    while (ancestor && !(ts.isJsxElement(ancestor) && ancestor.openingElement.tagName.getText(source) === 'form')) ancestor = ancestor.parent
    expect(ancestor).toBeDefined()
    expect(ancestor!.getText(source)).toContain('className="browser-toolbar"')
    expect(text).not.toContain('BrowserOperationRail')
    const styles = readFileSync(resolve(__dirname, '../src/renderer/src/styles/browser-operation-surface.css'), 'utf8')
    const trigger = styles.match(/\.browser-operation-status__trigger\s*\{([^}]*)\}/)
    expect(trigger).not.toBeNull()
    expect(trigger![1]).toMatch(/width:\s*27px/)
    expect(trigger![1]).toMatch(/height:\s*27px/)
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce[^}]*browser-operation-status[^}]*animation:\s*none/)
    expect(styles).not.toContain('browser-rsi-rail')
  })

  it('forwards typed control and distinct trusted handoff/Stop actions through the actual BrowserPane wrapper', async () => {
    const [{ BrowserPane }, { createClientUiRoot }, { api }, { useAppStore }] = await Promise.all([
      import('../src/renderer/src/components/BrowserPane'), import('./helpers/client-ui-render'),
      import('../src/renderer/src/lib/api'), import('../src/renderer/src/store')
    ])
    const previous = useAppStore.getState(), host = document.createElement('div')
    document.body.append(host)
    const root = createClientUiRoot(host), execute = vi.fn().mockResolvedValue(undefined)
    const page = await api.browser.create('density-browser', 'https://example.test/density', 'density-workspace')
    const take = vi.spyOn(api.browser, 'takeControl').mockResolvedValue(page)
    const resume = vi.spyOn(api.browser, 'returnControl').mockResolvedValue(page)
    vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
    vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
    useAppStore.setState({ toolsOpen: false, sessions: [], executeControl: execute })
    const active = { ...operation, browserId: page.id }, activity: BrowserActivityState = { operation: active, control: 'human' }
    const render = async (control: AgentMuxBrowserControl, nextActivity = activity) => await act(async () => root.render(<BrowserPane
      tab={{ ...page, kind: 'browser', browserId: page.id, regionId: 'density-region', workspaceId: 'density-workspace', control, activity: nextActivity }} visible />))
    try {
      await render(currentControl('agent', active.id))
      const status = host.querySelector('.browser-operation-status')!
      expect(status.getAttribute('data-control')).toBe('agent'); expect(status.getAttribute('data-operation-id')).toBe(active.id)
      expect(status.closest('form')?.classList.contains('browser-toolbar')).toBe(true)
      const direct = status.querySelector<HTMLButtonElement>('[aria-label="Take control of Browser"]')!
      expect(direct).not.toBeNull()
      await act(async () => direct.click())
      expect(take).toHaveBeenCalledExactlyOnceWith(page.id); expect(execute).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
      const trigger = status.querySelector<HTMLButtonElement>('[aria-label^="Browser activity:"]')!
      await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
      const stop = document.querySelector<HTMLElement>('.browser-operation-menu [aria-label="Stop browser operation"]')!
      expect(stop).not.toBeNull()
      await act(async () => stop.click())
      expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'browser.stop', operationId: active.id }))
      expect(take).toHaveBeenCalledTimes(1)

      await render(currentControl('human'), { operation: { ...active, phase: 'completed' }, control: 'agent' })
      const returned = host.querySelector<HTMLButtonElement>('[aria-label="Return to Agent"]')!
      expect(returned).not.toBeNull()
      await act(async () => returned.click())
      expect(resume).toHaveBeenCalledExactlyOnceWith(page.id)
      expect(execute).toHaveBeenCalledTimes(1); expect(take).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount()); host.remove()
      useAppStore.setState(previous, true); vi.restoreAllMocks()
      document.getElementById('agentmux-window-overlay-host')?.remove()
    }
  })
})
