import { act } from 'react'
import { expect, vi } from 'vitest'

/** The actual shared menu protocol; no hidden select or copied option registry. */
export async function openFocusFilters(container: HTMLElement) {
  const trigger=container.querySelector<HTMLButtonElement>('[aria-label="Focus filters"]')
  expect(trigger).not.toBeNull()
  await act(async()=>trigger!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowDown'})))
  await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.focus-filter-menu [role="menuitemradio"]')).not.toBeNull()})
  return document.querySelector<HTMLElement>('.focus-filter-menu')!
}
export async function chooseFocusFilter(container: HTMLElement, kind: 'project' | 'state', value: string) {
  const menu=await openFocusFilters(container),item=menu.querySelector<HTMLElement>(`[data-focus-${kind}="${value}"]`)
  expect(item).not.toBeNull();await act(async()=>item!.click());await act(async()=>{})
}
export async function focusFilterOptions(container: HTMLElement, kind: 'project' | 'state') {
  const menu=await openFocusFilters(container),items=[...menu.querySelectorAll<HTMLElement>(`[data-focus-${kind}]`)]
  expect(items.length).toBeGreaterThan(0)
  const options=items.map(item=>({value:item.getAttribute(`data-focus-${kind}`),text:item.textContent}))
  await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));await act(async()=>{})
  return options
}
