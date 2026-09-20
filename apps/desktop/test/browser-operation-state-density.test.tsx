// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserActivityState, BrowserOperation, BrowserOperationPhase } from '../src/shared/browser-operation'
import { BrowserOperationStatus, BrowserOperationWarning } from '../src/renderer/src/components/BrowserOperationSurface'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const operation: BrowserOperation = {
  id: 'observed-operation', browserId: 'browser', operator: { id: 'operator', name: 'Navigator' },
  startedAt: 1700000000000, phase: 'running', summary: 'Review settings', url: 'https://example.test',
  steps: [{ sequence: 1, method: 'click', label: 'Open settings', startedAt: 1700000000100,
    status: 'running', target: { role: 'button', name: 'Settings', ordinal: 1, count: 1 } }]
}

async function renderStatus(activity: BrowserActivityState, handlers = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(BrowserOperationStatus, { activity, ...handlers })))
  return { host, root, trigger: host.querySelector<HTMLButtonElement>('button')!,
    async close() { await act(async () => root.unmount()); host.remove() } }
}

describe('Browser operation status in existing controls', () => {
  it('renders four nonempty observed states with distinct glyphs and accessible facts', async () => {
    const cases: [BrowserOperationPhase, BrowserActivityState['control'], string, string][] = [
      ['running', 'agent', 'Operating page', '.semantic-icon--working'],
      ['waiting', 'agent', 'Waiting for page', '.lucide-pause'],
      ['human', 'human', 'Human has control', '.lucide-user-round'],
      ['failed', 'human', 'Failed', '.lucide-circle-x']
    ]
    expect(cases.map(([phase]) => phase)).toEqual(['running', 'waiting', 'human', 'failed'])
    for (const [phase, control, label, glyph] of cases) {
      const view = await renderStatus({ operation: { ...operation, phase }, control })
      try {
        expect(view.host.querySelector('.browser-operation-status')!.getAttribute('data-phase')).toBe(phase)
        expect(view.trigger.getAttribute('aria-label')).toContain(`Navigator · ${label} · button “Settings”`)
        expect(view.trigger.getAttribute('title')).toContain(label)
        expect(view.trigger.querySelector(glyph), phase).not.toBeNull()
        expect(view.host.querySelectorAll('button')).toHaveLength(1)
        expect(document.querySelector('.browser-operation-menu')).toBeNull()
        expect(view.host.textContent).toBe('')
      } finally { await view.close() }
    }
  })

  it('uses control ownership before a nonterminal phase projection catches up, and never calls unknown healthy', async () => {
    const human = await renderStatus({ operation, control: 'human' })
    try {
      expect(human.trigger.getAttribute('aria-label')).toContain('Human has control')
      expect(human.trigger.querySelector('.lucide-user-round')).not.toBeNull()
    } finally { await human.close() }
    const unknown = await renderStatus({ operation: null, control: 'agent' })
    try {
      expect(unknown.host.querySelector('.browser-operation-status')!.getAttribute('data-phase')).toBe('unknown')
      expect(unknown.trigger.getAttribute('aria-label')).toContain('Activity details are loading')
      expect(unknown.trigger.querySelector('.lucide-circle-alert')).not.toBeNull()
      expect(unknown.trigger.getAttribute('aria-label')).not.toContain('Completed')
    } finally { await unknown.close() }
  })

  it('opens actions on hover and invokes the actual stop callback with keyboard selection', async () => {
    const stop = vi.fn(), take = vi.fn(), history = vi.fn()
    const view = await renderStatus({ operation, control: 'agent' }, { onStop: stop, onTakeControl: take, onOpenTimeline: history })
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

  it('opens with keyboard and limits return/stop actions to a current operation', async () => {
    const resume = vi.fn()
    const view = await renderStatus({ operation: { ...operation, phase: 'human' }, control: 'human' }, { onReturnControl: resume, onStop: vi.fn() })
    try {
      await act(async () => { view.trigger.focus(); view.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      const menu = document.querySelector('.browser-operation-menu')!
      expect(menu).not.toBeNull()
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      expect(items.map(item => item.textContent)).toEqual(['Return to Agent', 'Stop operation'])
      await act(async () => items[0]!.click())
      expect(resume).toHaveBeenCalledExactlyOnceWith()
    } finally { await view.close() }
    const failed = await renderStatus({ operation: { ...operation, phase: 'failed' }, control: 'human' }, { onReturnControl: resume, onStop: vi.fn(), onOpenTimeline: vi.fn() })
    try {
      await act(async () => failed.trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
      expect(Array.from(document.querySelectorAll('.browser-operation-menu [role="menuitem"]')).map(item => item.textContent)).toEqual(['Activity'])
    } finally { await failed.close() }
  })

  it('keeps the reported failure and recovery line persistent while raw diagnostics mount only on demand', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const warning = 'The result is unknown. Inspect the page before retrying.\n    at private diagnostic frame'
    try {
      await act(async () => root.render(createElement(BrowserOperationWarning, { activity: { operation: { ...operation, phase: 'failed', warning }, control: 'human' } })))
      expect(host.querySelector('[role="status"]')!.textContent).toContain(warning.split('\n')[0])
      expect(host.textContent).not.toContain('private diagnostic frame')
      const details = host.querySelector<HTMLButtonElement>('[aria-label="Show browser warning details"]')!
      await act(async () => details.click())
      expect(host.querySelector('pre')!.textContent).toBe(warning)
      await act(async () => details.click())
      expect(host.querySelector('pre')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('mounts the real status inside the original toolbar and retains the standalone service notice', () => {
    const text = readFileSync(resolve(__dirname, '../src/renderer/src/components/BrowserPane.tsx'), 'utf8')
    const source = ts.createSourceFile('BrowserPane.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const status: ts.JsxSelfClosingElement[] = [], warnings: ts.JsxSelfClosingElement[] = []
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'BrowserOperationStatus') status.push(node)
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'BrowserOperationWarning') warnings.push(node)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(status).toHaveLength(1)
    expect(warnings).toHaveLength(1)
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
})
