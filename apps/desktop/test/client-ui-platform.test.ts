// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { bindDesktopComposerFocus } from '../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
const disposals: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})

function editor(regionId: string): { region: HTMLElement; input: HTMLInputElement } {
  const region = document.createElement('section')
  region.dataset.workbenchRegionId = regionId
  const input = document.createElement('input')
  region.append(input)
  document.body.append(region)
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 28))
  return { region, input }
}

it('retains an exact pending caret intent until its own visible editor accepts focus', async () => {
  useAppStore.setState({ regionCaretFocus: null })
  const { region, input } = editor('composer-region')
  const focus = vi.fn(() => { input.focus(); return document.activeElement === input })
  const dispose = bindDesktopComposerFocus(input, focus)
  disposals.push(dispose)
  useAppStore.setState({ regionCaretFocus: { regionId: 'another-region', nonce: 71 } })
  expect(focus).not.toHaveBeenCalled()
  region.setAttribute('inert', '')
  useAppStore.setState({ regionCaretFocus: { regionId: 'composer-region', nonce: 72 } })
  expect(focus).not.toHaveBeenCalled()
  expect(useAppStore.getState().regionCaretFocus).toEqual({ regionId: 'composer-region', nonce: 72 })
  region.removeAttribute('inert')
  await vi.waitFor(() => expect(document.activeElement).toBe(input))
  expect(focus).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  useAppStore.setState({ error: 'Unrelated service notice' })
  expect(focus).toHaveBeenCalledTimes(1)
  dispose()
  useAppStore.setState({ regionCaretFocus: { regionId: 'composer-region', nonce: 73 } })
  expect(focus).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().regionCaretFocus).toEqual({ regionId: 'composer-region', nonce: 73 })
})

it('keeps a Terminal input intent with its Terminal owner', () => {
  const { region, input } = editor('terminal-region')
  region.dataset.inputSurface = 'terminal'
  useAppStore.setState({ regionCaretFocus: { regionId: 'terminal-region', nonce: 81 } })
  const focus = vi.fn(() => true)
  disposals.push(bindDesktopComposerFocus(input, focus))
  expect(focus).not.toHaveBeenCalled()
  expect(useAppStore.getState().regionCaretFocus).toEqual({ regionId: 'terminal-region', nonce: 81 })
})
