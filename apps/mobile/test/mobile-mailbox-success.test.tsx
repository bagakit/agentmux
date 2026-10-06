import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const cssText=readFileSync(createRequire(import.meta.url).resolve('../src/conversation/conversation.css'),'utf8')
import { GRAPHITE_THEME,RETRO_THEME,mountThemeRuntime,previewTheme } from '@agentmux/client-ui/theme'
import { MobileMailbox } from '../src/conversation/MobileMailbox'
import { createBrowserPlatform } from '../src/platform/browser'
import { mount,mounted,session } from './conversation-fixture'
const historyProps = { historyScope: 'original-host-session', readHistory: async () => { throw new Error('This marker-only test does not open the original reader') },
 onHistoryFill: async () => {}, onHistoryCopy: async () => false }
let cleanup:()=>void
beforeEach(()=>cleanup=mountThemeRuntime(window));afterEach(async()=>{await act(async()=>{for(const view of mounted.splice(0)){view.root.unmount();view.element.remove()}});cleanup();document.body.replaceChildren();vi.restoreAllMocks()})
it('actual mailbox completion consumes Success while active work retains Action and original state, glyph and label',async()=>{
 expect(cssText).toMatch(/i\[data-state='done'\]\s*\{\s*background:\s*var\(--success\)/);expect(cssText).toMatch(/i\[data-state='working'\]\s*\{\s*background:\s*var\(--green\)/)
 const original=session(),view=await mount(<MobileMailbox {...historyProps} session={original} connected messages={[]} platform={createBrowserPlatform()} describeSpeaker={()=>({name:'原作者'})} refresh={()=>{}} terminal={()=>{}}/>),trigger=view.element.querySelector('button')!,marker=trigger.querySelector('i')!
 original.semanticStatus={state:'done',source:'native-hook',observedAt:_reshape_fixtureEpoch(0, 0, 1)};await view.render(<MobileMailbox {...historyProps} session={original} connected messages={[]} platform={createBrowserPlatform()} describeSpeaker={()=>({name:'原作者'})} refresh={()=>{}} terminal={()=>{}}/>);expect(marker.dataset.state).toBe('done');expect(trigger.getAttribute('aria-label')).toBe('通信记录 · 已完成');expect(decodeURIComponent(document.documentElement.style.getPropertyValue('--native-presence-done-mask'))).toContain('<circle')
 await act(async()=>{expect(previewTheme(RETRO_THEME).applied).toBe(true)});expect(document.documentElement.style.getPropertyValue('--success')).not.toBe(document.documentElement.style.getPropertyValue('--green'));expect(view.element.querySelector('button')).toBe(trigger);expect(marker.dataset.state).toBe('done')
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.mailbox-success';custom.name='Mailbox action and success';for(const variant of Object.values(custom.variants)){variant.colors.action='#e58b35';variant.colors.success='#42c98b'}await act(async()=>{expect(previewTheme(custom).applied).toBe(true)});expect(document.documentElement.style.getPropertyValue('--green')).toBe('#e58b35');expect(document.documentElement.style.getPropertyValue('--success')).toBe('#42c98b');expect(trigger.getAttribute('aria-label')).toBe('通信记录 · 已完成')
})
