// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BotSetupGuide } from '../src/renderer/src/components/settings/BotSetupGuide'

it('treats null as no current step while confirmations and ready remain independent caller facts', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container)
  document.body.append(container)
  try {
    await act(async () => root.render(<BotSetupGuide stage="ready" />))
    expect(container.querySelector('[aria-current]')?.getAttribute('data-step')).toBe('4')
    expect(container.querySelectorAll('[data-state="recorded"]')).toHaveLength(0)
    await act(async () => root.render(<BotSetupGuide stage="ready" currentStep={null} confirmedSteps={[1]} />))
    expect(container.querySelector('[aria-current]')).toBeNull()
    expect(container.querySelectorAll('[data-state="recorded"]')).toHaveLength(1)
    expect(container.querySelector('[data-step="4"]')?.textContent).not.toContain('Confirmed')
    await act(async () => root.render(<BotSetupGuide stage="ready" currentStep={null} confirmedSteps={[1, 2, 3, 4]} />))
    expect(container.querySelectorAll('[data-state="recorded"]')).toHaveLength(4)
    expect(container.querySelector('[aria-current]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
