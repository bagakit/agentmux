import { act } from 'react'
import { expect, vi } from 'vitest'
import { button, click, waitForElement } from './conversation-fixture'

const visible = (element: HTMLElement, selector: string) =>
  [...element.querySelectorAll<HTMLElement>(selector)].find(value => !value.closest('[hidden]')) ?? null

/** The tab bar exists only on root pages; a drilled page reaches it through back, one layer at a time, as a person does. */
export async function returnToRoot(element: HTMLElement): Promise<HTMLElement> {
  for (let depth = 0; depth < 4 && !element.querySelector('.mobile-navigation'); depth++) {
    const back = visible(element, '[data-mobile-back]')
    if (!back) break
    await click(back)
  }
  const navigation = element.querySelector<HTMLElement>('.mobile-navigation')
  if (!navigation) throw new Error('No root page with the tab bar is reachable through back')
  return navigation
}

export async function openPrimary(element: HTMLElement, name: string): Promise<void> {
  await click(button(await returnToRoot(element), name))
}

async function waitForVisible(element: HTMLElement, selector: string, subject: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    found = visible(element, selector)
    expect(found, subject).not.toBeNull()
  }, { timeout: 4000, interval: 10 })
  return found!
}

/** The Mote tab opens a recent or primary Mote's saved main conversation; otherwise the directory asks which Mote, and choosing it opens that main. */
export async function openMoteMain(element: HTMLElement): Promise<void> {
  await openPrimary(element, 'Mote')
  if (!visible(element, '.mobile-mote-context[data-variant="main"]')) await click(await waitForVisible(element, '.mobile-mote-choice', 'A visible Mote choice in the Mote directory'))
  const strip = await waitForElement(element, '.mobile-mote-context[data-variant="main"]')
  expect(strip.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Discussion')
  expect(element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
}

/** One exact Agent opens from its Mote's Agents list, which sits one back behind that Mote's main conversation. */
export async function openMoteAgent(element: HTMLElement): Promise<void> {
  await openMoteMain(element)
  await click(visible(element, '[data-mobile-back]')!)
  await click(await waitForVisible(element, '.mobile-mote-agents .mobile-agent-row__open', 'A visible Agent row in the Mote Agents list'))
  await waitForElement(element, '.mobile-mote-context[data-variant="member"]')
  expect(element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
}
