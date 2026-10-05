import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpaceIconPicker } from '../src/renderer/src/components/SpaceIconPicker'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { configOwnerFixture } from './helpers/config-owner-fixture'
const key=JSON.stringify(['local',_hygiene_fixturePath("work/mote")]), target={key,name:'Mote',kind:'mote' as const,avatarTarget:{workspaceId:'__scratch__',topicId:'view:mote',objectKey:key}}
let cleanup:(()=>Promise<void>)|undefined
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)})
afterEach(async()=>{await cleanup?.();cleanup=undefined;vi.restoreAllMocks();vi.unstubAllGlobals()})
async function mount(choice:unknown) {
  const f=await configOwnerFixture({appearance:{terminalTheme:'graphite',spaceObjectIcons:choice===null?{}:{[key]:choice}}})
  useAppStore.getState().setConfig(f.owner.current)
  vi.spyOn(api.config,'get').mockImplementation(async()=>f.owner.current)
  vi.spyOn(api.config,'save').mockImplementation((after,before)=>f.owner.edit(before,after))
  vi.spyOn(api.scratch,'readMoteAvatar').mockResolvedValue({dataUrl:'data:image/png;base64,eA==',width:256,height:256})
  const container=document.createElement('div');document.body.append(container);const root=createClientUiRoot(container),close=vi.fn()
  const render=async(value:typeof target|null)=>{await act(async()=>root.render(createElement(SpaceIconPicker,{target:value,onClose:close})))}
  await render(target)
  cleanup=async()=>{await act(async()=>root.unmount());container.remove()}
  return {f,render,close}
}
function button(label:string){const node=[...document.querySelectorAll<HTMLButtonElement>('.space-icon-picker button')].find(n=>n.getAttribute('aria-label')===label||n.textContent===label);expect(node,label).toBeDefined();return node!}
it.each([['face',DEFAULT_MOTE_FACE],['glyph','book'],['image',{kind:'image',fileName:'a'.repeat(64)+'.png'}],['automatic',null]])('reopens saved %s source and Save preserves exactly the selected source',async(source,choice)=>{
  const {f,close}=await mount(choice)
  expect(button('Make a face').getAttribute('aria-pressed')).toBe(source==='face'?'true':'false')
  expect(button('Icon or image').getAttribute('aria-pressed')).toBe(source==='face'?'false':'true')
  if(source==='glyph') expect(button('Book icon').getAttribute('aria-pressed')).toBe('true')
  if(source==='automatic') expect(button('Restore automatic').getAttribute('aria-pressed')).toBe('true')
  await act(async()=>button(source==='face'?'Save face':'Save avatar').click())
  expect(close).toHaveBeenCalledTimes(1)
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual(choice===null?{}:{[key]:choice})
})
it('a failed original writer keeps the saved source and visible edited draft; Cancel executes nothing',async()=>{
  const {f,close}=await mount('book')
  await act(async()=>button('Brain icon').click())
  vi.mocked(api.config.save).mockRejectedValueOnce(new Error('configuration unavailable'))
  await act(async()=>button('Save avatar').click())
  expect(document.querySelector('[role=alert]')?.textContent).toContain('configuration unavailable')
  expect(button('Brain icon').getAttribute('aria-pressed')).toBe('true')
  expect(useAppStore.getState().spaceObjectIcons[key]).toBe('book')
  expect((await f.disk()).appearance.spaceObjectIcons?.[key]).toBe('book')
  expect(close).not.toHaveBeenCalled()
})
