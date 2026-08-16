// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentComposerTools } from '../src/renderer/src/components/AgentComposerTools'

// The "同一份结果不得反复重算" caching (design SSOT) lives in Core's discoverAgentSkills, NOT here: the
// component's inputs (workspace/provider) mutate in place in the launcher without a remount, so it cannot
// tell a plain re-open from a real folder change and must always delegate. These tests pin that split —
// the component re-delegates on each open (Core decides cache vs re-walk) and surfaces result/error.

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

async function pointer(target: Element, type: string) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0 })))
}
// The composer rests collapsed (only the mode toggle shows); click it once to reveal the tool row that
// holds the Skills trigger.
const modeToggle = () => container.querySelector<HTMLButtonElement>('.composer-tool--mode')!
async function revealTools() { await act(async () => modeToggle().click()) }
const skillsButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Skills'))!
async function reopen() {
  await pointer(skillsButton(), 'pointerout')
  await act(async () => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await pointer(skillsButton(), 'pointerover')
}

it('delegates discovery to loadSkills on each open and shows the result — caching is Core’s job, not the menu’s', async () => {
  const skill = { name: 'review', description: 'Review', path: '/skills/review/SKILL.md', source: 'project' as const }
  const loadSkills = vi.fn(async () => [skill])
  await act(async () => root.render(<AgentComposerTools disabled={false} commands={[]}
    loadSkills={loadSkills} onChooseSkill={vi.fn()} onCommand={vi.fn()} reportError={vi.fn()} />))
  await revealTools()
  await pointer(skillsButton(), 'pointerover')
  await act(async () => {})
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('review')
  expect(loadSkills).toHaveBeenCalledOnce()
  // Re-open: the component asks again (Core memoizes, so this is cheap) — it must NOT freeze on a
  // component-local snapshot that a launcher provider-switch could leave stale.
  await reopen()
  await act(async () => {})
  expect(loadSkills).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('review')
})

it('shows a discovery failure and retries on the next open rather than freezing the error', async () => {
  const loadSkills = vi.fn()
    .mockRejectedValueOnce(new Error('discovery boom'))
    .mockResolvedValueOnce([{ name: 'later', description: '', path: '/s/later/SKILL.md', source: 'user' as const }])
  await act(async () => root.render(<AgentComposerTools disabled={false} commands={[]}
    loadSkills={loadSkills} onChooseSkill={vi.fn()} onCommand={vi.fn()} reportError={vi.fn()} />))
  await revealTools()
  await pointer(skillsButton(), 'pointerover')
  await act(async () => {}) // let the rejected promise settle
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('discovery boom')
  await reopen()
  await act(async () => {})
  expect(loadSkills).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('later')
})
