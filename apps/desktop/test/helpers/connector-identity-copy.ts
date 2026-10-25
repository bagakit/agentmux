import { act } from 'react'
import { expect, vi } from 'vitest'
import { api } from '../../src/renderer/src/lib/api'

/** Click the real consumer's copy action and inspect the Desktop clipboard boundary. */
export async function copyConnectorIdentity(container: ParentNode, label: string, original: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label)
  expect(button, label).toBeDefined()
  for (let details = button!.closest<HTMLDetailsElement>('details:not([open])'); details; details = button!.closest<HTMLDetailsElement>('details:not([open])')) {
    await act(async () => details!.querySelector<HTMLElement>('summary')!.click())
  }
  const before = vi.mocked(api.ui.writeClipboardText).mock.calls.length
  await act(async () => button!.click())
  await vi.waitFor(() => expect(button!.dataset.copyState).toBe('copied'))
  expect(vi.mocked(api.ui.writeClipboardText).mock.calls.slice(before)).toEqual([[original]])
  return button!
}
