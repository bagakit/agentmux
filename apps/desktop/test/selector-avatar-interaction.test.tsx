// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SelectorPresence } from '../src/renderer/src/components/SelectorList.js'
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
describe('Selector avatar interaction', () => {
  it('aggregate identity remains part of the Branch button; clicking it opens the branch', async () => {
    const openBranch = vi.fn()
    await act(async () => root.render(createElement('button', { onClick: openBranch }, createElement(SelectorPresence, {
      agents: [{ key: 'codex', providerId: 'codex', label: 'Codex', state: 'running', count: 2 }]
    }))))
    expect(container.querySelectorAll('button')).toHaveLength(1)
    const avatar = container.querySelector<HTMLElement>('.agent-avatar')!
    expect(avatar.getAttribute('role')).toBe('img')
    await act(async () => avatar.click())
    expect(openBranch).toHaveBeenCalledOnce()
  })
  it('a concrete Agent target is keyboard focusable and opens independently of the row', async () => {
    const openAgent = vi.fn()
    const openRow = vi.fn()
    await act(async () => root.render(createElement('div', { onClick: openRow }, createElement(SelectorPresence, {
      agents: [{ key: 'session', providerId: 'codex', label: 'Reviewer', state: 'waiting', onOpen: openAgent }]
    }))))
    const button = container.querySelector<HTMLButtonElement>('button.agent-avatar')!
    expect(button).not.toBeNull()
    expect(button.type).toBe('button')
    button.focus()
    expect(document.activeElement).toBe(button)
    await act(async () => button.click())
    expect(openAgent).toHaveBeenCalledOnce()
    expect(openRow).not.toHaveBeenCalled()
  })
})
