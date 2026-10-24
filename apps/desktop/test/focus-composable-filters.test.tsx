// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FocusFilters } from '../src/renderer/src/components/FocusFilters'
import { EMPTY_FOCUS_FILTERS, focusMatchesState, type FocusFilters as Selection } from '../src/renderer/src/lib/focus-filters'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'

it('keeps an unavailable selected project visible with its original identity and an explicit removal', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  function Fixture({ available = false }: { available?: boolean }) {
    const [value, setValue] = useState<Selection>({...EMPTY_FOCUS_FILTERS, projects:[{id:'exact-original',name:'Original Project'}]})
    return <FocusFilters value={value} onChange={setValue} visible options={{projects:available?[{id:'exact-original',name:'Latest confirmed name',count:1}]:[],states:new Map(),types:new Map()}} onClear={()=>{}} onHistory={()=>{}} historyAvailable={false} />
  }
  try {
    await act(async()=>root.render(<Fixture />))
    const trigger=host.querySelector<HTMLButtonElement>('[aria-label="Focus filters"]')!
    expect(trigger.getAttribute('aria-description')).toBe('Original Project · Unavailable · All states · All types')
    await act(async()=>root.render(<Fixture available />))
    expect(trigger.getAttribute('aria-description')).toBe('Latest confirmed name · All states · All types')
    await act(async()=>root.render(<Fixture />))
    expect(trigger.getAttribute('aria-description')).toBe('Latest confirmed name · Unavailable · All states · All types')
    await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowDown'})))
    const original=document.querySelector<HTMLElement>('[data-focus-project="exact-original"]')!
    expect(original).not.toBeNull();expect(original.getAttribute('aria-checked')).toBe('true');expect(original.textContent).toContain('Unavailable')
    await act(async()=>original.click())
    expect(document.querySelector('.focus-filter-menu')).not.toBeNull()
    expect(trigger.getAttribute('aria-description')).toBe('All projects · All states · All types')
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()}
})

it('refines activity unknown and confirmed recovery without turning an unobserved healthy Run into recovery', () => {
  const rows = [
    { id:'unobserved',bucket:'idle',processState:'interrupted',runUnobserved:true,activitySemantic:'unknown' },
    { id:'interrupted',bucket:'idle',processState:'interrupted',runUnobserved:false },
    { id:'idle',bucket:'idle',processState:'running',activitySemantic:'idle' },
    { id:'unknown',bucket:'idle',processState:'running',activitySemantic:'unknown' },
    { id:'working',bucket:'working',processState:'running',activitySemantic:'active' }
  ] as FocusContext[]
  expect(rows.filter(row=>focusMatchesState(row,['recovery'])).map(row=>row.id)).toEqual(['interrupted'])
  expect(rows.filter(row=>focusMatchesState(row,['unknown'])).map(row=>row.id)).toEqual(['unobserved','unknown'])
  expect(rows.filter(row=>focusMatchesState(row,['idle'])).map(row=>row.id)).toEqual(['unobserved','interrupted','idle','unknown'])
})

it('provides keyboard option search, reflects current names and returns chip removal focus to the visible trigger', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  function Fixture() {
    const [value,setValue]=useState<Selection>({...EMPTY_FOCUS_FILTERS,projects:[{id:'original',name:'Old name'}]})
    return <FocusFilters value={value} onChange={setValue} visible options={{projects:[{id:'original',name:'Renamed project',count:1}],states:new Map(),types:new Map()}} onClear={()=>{}} onHistory={()=>{}} historyAvailable />
  }
  try {
    await act(async()=>root.render(<Fixture />))
    const trigger=host.querySelector<HTMLButtonElement>('[aria-label="Focus filters"]')!
    expect(trigger.getAttribute('aria-description')).toContain('Renamed project')
    await act(async()=>trigger.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',buttons:0})))
    const hovered=document.querySelector<HTMLElement>('.focus-filter-menu')!
    expect(hovered).not.toBeNull();await act(async()=>hovered.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})))
    const chip=host.querySelector<HTMLButtonElement>('.focus-filter-chip__value')!
    expect(chip).not.toBeNull();await act(async()=>chip.click())
    expect(document.querySelector('.focus-filter-menu')?.contains(document.activeElement)).toBe(true)
    await act(async()=>document.querySelector('.focus-filter-menu')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})))
    await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowDown'})))
    const menu=document.querySelector<HTMLElement>('.focus-filter-menu')!
    expect(menu).not.toBeNull();await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Tab'})))
    const search=menu.querySelector<HTMLInputElement>('[aria-label="Find Focus filter options"]')!
    expect(document.activeElement).toBe(search)
    await act(async()=>search.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowDown'})))
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemcheckbox')
    const done=[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent==='Done')!
    expect(done).not.toBeNull();await act(async()=>done.click())
    const remove=host.querySelector<HTMLButtonElement>('[aria-label="Remove Project filter"]')!
    expect(remove).not.toBeNull();remove.focus();await act(async()=>remove.click())
    expect(document.activeElement).toBe(trigger)
    expect(host.querySelector('[aria-label="Remove Project filter"]')).toBeNull()
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()}
})
