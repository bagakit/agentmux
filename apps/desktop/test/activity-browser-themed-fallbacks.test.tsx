// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { GRAPHITE_THEME,mountThemeRuntime,previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { BrowserWorkfaceBoundary } from '../src/renderer/src/components/BrowserWorkfaceBoundary'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom=composerDOM();let cleanup:()=>void
beforeEach(()=>cleanup=mountThemeRuntime(window));afterEach(()=>cleanup())
it('the actual Activity working indicator uses a theme glyph while the original typed work state and draft stay independent',async()=>{
 const props={sessionId:'agent-1',items:[],capability:'streaming' as const,describeSpeaker:()=>({name:'Original speaker'})};await dom.render(<ActivityView {...props} displayState="working"/>);const status=dom.container.querySelector<HTMLElement>('.activity-working')!,shape=status.querySelector('svg')!;expect(status).not.toBeNull();expect(status.textContent).toContain('Working…');expect(shape.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.working'));expect(shape.getAttribute('width')).toBe('12');expect(status.querySelectorAll('i')).toHaveLength(0)
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.activity-working';custom.name='Activity work icon';custom.icons={'status.working':{kind:'paths',paths:[{d:'M4 4H20V20H4Z'}]}};await act(async()=>{expect(previewTheme(custom).applied).toBe(true)});expect(dom.container.querySelector('.activity-working')).toBe(status);expect(status.querySelector('svg')).toBe(shape);expect(document.getElementById(semanticIconHref('status.working').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft');await dom.render(<ActivityView {...props} displayState="waiting"/>);expect(dom.container.querySelector('.activity-working')).toBeNull();expect(dom.container.textContent).toContain('No structured activity yet')
})
it('actual Browser fault recovery themes its split close while preserving the original address draft and close callback',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});const snapshot=await api.browser.create('original-browser','https://example.invalid/','workspace'),tab={...snapshot,kind:'browser' as const,browserId:snapshot.id,regionId:'original-browser-region',workspaceId:'workspace'},draft={current:{browserId:tab.browserId,value:'Original unsent address',edited:true}},close=vi.fn();function Failure():never{throw Error('Original supplied render failure')}
 await dom.render(<BrowserWorkfaceBoundary tab={tab} addressDraft={draft} onRegionClose={close}><Failure/></BrowserWorkfaceBoundary>);const input=dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!,button=dom.container.querySelector<HTMLButtonElement>('[aria-label="Close split"]')!;expect(input.value).toBe('Original unsent address');expect(dom.container.textContent).toContain('Browser view could not display');expect(button.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.close'))
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.browser-fallback';custom.name='Browser fallback icon';custom.icons={'action.close':{kind:'glyph',glyph:'circle-x'}};await act(async()=>{expect(previewTheme(custom).applied).toBe(true)});expect(dom.container.querySelector('[aria-label="Browser address"]')).toBe(input);expect(input.value).toBe('Original unsent address');expect(dom.container.querySelector('[aria-label="Close split"]')).toBe(button);expect(document.getElementById(semanticIconHref('action.close').slice(1))?.children.length).toBeGreaterThan(0);await act(async()=>button.click());expect(close).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({type:'click',target:button}));expect(draft.current.value).toBe('Original unsent address')
})
