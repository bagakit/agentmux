// @vitest-environment happy-dom
import { act, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { FocusProjectPreferences, type FocusDiscussionSlot } from '../src/renderer/src/components/FocusProjectPreferences'
import { FocusZoneLayoutToggle } from '../src/renderer/src/components/FocusZoneLayoutToggle'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { focusZoneContainerKey } from '../src/shared/focus-zone-presentation'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import type { AppConfig } from '../src/shared/contracts'
const dom = composerDOM(), key = focusZoneContainerKey('project','local','one'), second = focusZoneContainerKey('project','remote','one')
const project = { key: JSON.stringify(['local','one']), pinned: true, note: 'Original note', color: 'blue' as const, collapsed: null }
function button(name:string) { const node=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.getAttribute('aria-label')===name || node.textContent===name);expect(node,name).not.toBeUndefined();return node! }
async function click(name:string) { await act(async()=>button(name).click()) }
function deferred<T>() { let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject} }
function setup() { useAppStore.setState({config:{...composerConfig,focus:{recentActivityHours:48,projects:[project]}}}) }
it('a failed direct layout keeps its exact retry intent while newer note drafts and unrelated fields remain intact',async()=>{
 setup();const save=vi.spyOn(api.config,'save').mockImplementation(async(next,expected)=>applyConfigEdit(useAppStore.getState().config!,expected!,next))
 await dom.render(<><FocusZoneLayoutToggle containerKey={key} name="One" presentation="cards" defaultPresentation="cards"/><FocusProjectPreferences projectKey={project.key} name="One"/></>)
 await click('Project preferences · One')
 expect(document.querySelector('[data-focus-project-preferences] [data-focus-zone-presentation]')).toBeNull()
 const input=document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Later unsaved note');input.dispatchEvent(new Event('input',{bubbles:true}))})
 const request=deferred<AppConfig>();save.mockImplementationOnce(async()=>request.promise)
 await click('Sections · One');expect(button('Sections · One').disabled).toBe(true)
 expect(input.value).toBe('Later unsaved note')
 await act(async()=>request.reject(Error('Original layout disk failure')))
 expect(dom.container.querySelector('.focus-zone-layout__status')?.textContent).toContain('Original layout disk failure')
 await click('Retry layout')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key,presentation:'sections'}])
 expect(input.value).toBe('Later unsaved note');expect(input.isConnected).toBe(true)
 await click('Save project preferences')
 expect(useAppStore.getState().config?.focus?.projects?.[0]?.note).toBe('Later unsaved note')
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key,presentation:'sections'}])
})
it('an old scope acknowledgement cannot replace an externally published choice or publish failure into another exact container',async()=>{
 setup();const request=deferred<AppConfig>(),save=vi.spyOn(api.config,'save').mockImplementationOnce(async()=>request.promise)
 await dom.render(<FocusZoneLayoutToggle containerKey={key} name="One" presentation="cards" defaultPresentation="cards"/>)
 await click('Sections · One')
 const external={...useAppStore.getState().config!,focus:{recentActivityHours:48 as const,zonePresentations:[{key:second,presentation:'sections' as const}],projects:[{...project,note:'Newer published note'}]}}
 await act(async()=>useAppStore.setState({config:external}))
 await dom.render(<FocusZoneLayoutToggle containerKey={second} name="Other Host" presentation="sections" defaultPresentation="cards"/>)
 await act(async()=>request.resolve({...composerConfig,focus:{recentActivityHours:48,zonePresentations:[{key,presentation:'sections'}]}}))
 expect(useAppStore.getState().config).toBe(external);expect(dom.container.querySelector('.focus-zone-layout__status')).toBeNull()
 expect(button('Tags · Other Host').disabled).toBe(false)
 save.mockImplementation(async(next,expected)=>applyConfigEdit(useAppStore.getState().config!,expected!,next))
 await click('Tags · Other Host');expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:second,presentation:'cards'}])
 expect(useAppStore.getState().config?.focus?.projects?.[0]?.note).toBe('Newer published note')
 await dom.render(<FocusZoneLayoutToggle containerKey={key} name="One" presentation="cards" defaultPresentation="cards"/>)
 expect(dom.container.querySelector('.focus-zone-layout__status')).toBeNull();expect(button('Sections · One').disabled).toBe(false)
})
it('a late failed operation cannot replace a later container pending state or its exact original intent',async()=>{
 setup();const earlier=deferred<AppConfig>(),later=deferred<AppConfig>()
 vi.spyOn(api.config,'save').mockImplementationOnce(async()=>earlier.promise).mockImplementationOnce(async()=>later.promise)
 await dom.render(<FocusZoneLayoutToggle containerKey={key} name="One" presentation="cards" defaultPresentation="cards"/>)
 await click('Sections · One')
 await dom.render(<FocusZoneLayoutToggle containerKey={second} name="Other Host" presentation="sections" defaultPresentation="cards"/>)
 await click('Tags · Other Host');expect(button('Tags · Other Host').disabled).toBe(true)
 await act(async()=>earlier.reject(Error('Earlier scope failure')))
 expect(dom.container.querySelector('.focus-zone-layout__status')?.textContent).toBe('Saving layout…')
 expect(dom.container.textContent).not.toContain('Earlier scope failure')
 await act(async()=>later.resolve({...composerConfig,focus:{recentActivityHours:48,zonePresentations:[{key:second,presentation:'cards'}]}}))
 expect(dom.container.querySelector('.focus-zone-layout__status')).toBeNull()
 expect(useAppStore.getState().config?.focus?.zonePresentations).toEqual([{key:second,presentation:'cards'}])
})
it('discussion owners mount only after opening, retain their receipt while closed and never retain the hidden Popover content',async()=>{
 setup();let mounts=0,unmounts=0;const activeReads=vi.fn()
 function Discussion({active,container}:FocusDiscussionSlot) {
  const [receipt,setReceipt]=useState('Not submitted')
  useEffect(()=>{++mounts;return()=>{++unmounts}},[])
  useEffect(()=>{if(active)activeReads()},[active])
  return container?createPortal(<button onClick={()=>setReceipt('Original request queued')}>{receipt}</button>,container):null
 }
 await dom.render(<FocusProjectPreferences projectKey={project.key} name="One" discussion={state=><Discussion {...state}/>}/>)
 expect(mounts).toBe(0);expect(activeReads).not.toHaveBeenCalled()
 await click('Project preferences · One');expect(mounts).toBe(1);await click('Not submitted')
 await click('Cancel');expect(unmounts).toBe(0);expect(document.querySelector('[data-focus-project-preferences]')).toBeNull();expect(document.querySelector('[data-focus-group-discussion-host]')).toBeNull()
 const reads=activeReads.mock.calls.length
 await act(async()=>useAppStore.setState({config:{...useAppStore.getState().config!}}));expect(activeReads).toHaveBeenCalledTimes(reads)
 await click('Project preferences · One');expect(mounts).toBe(1);expect(button('Original request queued')).not.toBeNull()
})

it('leaving Focus closes the actual panel without reviving it on return or losing the retained discussion receipt',async()=>{
 setup();let mounts=0,unmounts=0
 function Discussion({active,container}:FocusDiscussionSlot){
  const [receipt,setReceipt]=useState('Not submitted')
  useEffect(()=>{++mounts;return()=>{++unmounts}},[])
  return active&&container?createPortal(<button onClick={()=>setReceipt('Original request queued')}>{receipt}</button>,container):null
 }
 const render=(active:boolean)=>dom.render(<FocusProjectPreferences active={active} projectKey={project.key} name="One" discussion={slot=><Discussion {...slot}/>}/>)
 await render(true);await click('Project preferences · One')
 const note=document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(note,'Unsubmitted project note');note.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('Not submitted');expect(mounts).toBe(1)
 const later=document.createElement('button');later.textContent='Original project Launcher';document.body.appendChild(later)
 try{
  await render(false)
  expect(document.querySelector('[data-focus-project-preferences]')).toBeNull()
  expect(document.querySelector('[data-focus-group-discussion-host]')).toBeNull()
  await act(async()=>later.focus());expect(document.activeElement).toBe(later);expect(unmounts).toBe(0)
  await render(true)
  expect(document.querySelector('[data-focus-project-preferences]')).toBeNull()
  expect(document.activeElement).toBe(later);expect(mounts).toBe(1)
  await click('Project preferences · One');expect(button('Original request queued')).not.toBeNull();expect(mounts).toBe(1)
  expect(document.querySelector<HTMLInputElement>('[aria-label="Project note"]')?.value).toBe('Unsubmitted project note')
  await click('Cancel');await click('Project preferences · One')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Project note"]')?.value).toBe('Original note')
  expect(button('Original request queued')).not.toBeNull();expect(mounts).toBe(1)
 }finally{later.remove()}
})
