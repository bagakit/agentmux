// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotSetupGuide } from '../src/renderer/src/components/settings/BotSetupGuide'

let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('keeps all numbered milestones visible while the current stage changes', async () => {
  await act(async () => root.render(<BotSetupGuide stage="prepare" />))
  expect(container.querySelectorAll('li')).toHaveLength(4)
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Identity')
  await act(async () => root.render(<BotSetupGuide stage="scan" confirmedSteps={[1]} />))
  expect(container.querySelectorAll('li')).toHaveLength(4)
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Sign in')
  expect(container.querySelector('[data-step="1"]')?.getAttribute('data-state')).toBe('recorded')
  expect(container.querySelector('button,input,svg,[aria-live]')).toBeNull()
})
it('does not infer completed steps from the current number or from an existing application', async () => {
  await act(async () => root.render(<BotSetupGuide stage="attention" currentStep={4} existingApplication confirmedSteps={[1]} />))
  expect(container.querySelector('[data-step="2"]')?.getAttribute('data-state')).toBe('upcoming')
  expect(container.querySelector('[data-step="2"]')?.textContent).not.toContain('Confirmed')
  expect(container.querySelector('[data-step="3"]')?.textContent).toContain('Already saved')
  expect(container.querySelector('[data-step="3"]')?.textContent).not.toContain('Create bot')
  expect(container.querySelector('[data-step="4"]')?.textContent).toContain('Needs attention')
})

it('renders explicit completion without promoting the ready label or a waiting step into evidence', async () => {
  await act(async () => root.render(<BotSetupGuide stage="ready" currentStep={null} />))
  expect(container.querySelector('[aria-current="step"]')).toBeNull()
  expect(container.querySelectorAll('[data-state="recorded"]')).toHaveLength(0)
  await act(async () => root.render(<BotSetupGuide stage="attention" currentStep={4} confirmedSteps={[1, 2, 3]} currentStatus="Waiting for platform approval" />))
  expect(container.querySelector('[data-step="4"]')?.getAttribute('data-state')).toBe('attention')
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Waiting for platform approval')
  await act(async () => root.render(<BotSetupGuide stage="ready" currentStep={null} confirmedSteps={[1, 2, 3, 4]} />))
  expect(container.querySelectorAll('[data-state="recorded"]')).toHaveLength(4)
  expect(container.querySelector('[aria-current="step"]')).toBeNull()
  expect(container.querySelector('button,input,[aria-live]')).toBeNull()
})
