import { act } from 'react'
import { expect } from 'vitest'

/** Use the equivalent list destination without depending on the topology's coordinates. */
export async function selectSettingsHost(container: HTMLElement, id: string, panel = 'connection') {
  const list = container.querySelector<HTMLButtonElement>('[aria-label="List"]')
  if (list && list.getAttribute('aria-pressed') !== 'true') await act(async () => list.click())
  const branch = [...container.querySelectorAll<HTMLDetailsElement>('[data-host-disclosure]')]
    .find(node => node.dataset.hostDisclosure === id)
  expect(branch, `Host ${id} is in the actual connection list`).toBeDefined()
  // Happy DOM does not activate native summaries; exercise their real toggle binding.
  await act(async () => { branch!.open = true; branch!.dispatchEvent(new Event('toggle')) })
  const target = [...branch!.querySelectorAll<HTMLButtonElement>('[data-host-panel]')]
    .find(node => node.dataset.hostPanel === panel)
  expect(target, `Host ${id} has a ${panel} destination`).toBeDefined()
  await act(async () => target!.click())
}
