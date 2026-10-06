import './mobile-lan-crypto.setup'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { GRAPHITE_THEME,mountThemeRuntime,previewTheme } from '@agentmux/client-ui/theme'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface,getDeviceWorkface } from '../src/recovery/device-workface'
import { button,click,editor,fixture,mount,mounted,paste } from './conversation-fixture'
const require=createRequire(import.meta.url),goalsCSS=readFileSync(require.resolve('../src/goals/goals.css'),'utf8'),conversationCSS=readFileSync(require.resolve('../src/conversation/conversation.css'),'utf8');let cleanup:()=>void
beforeEach(async()=>{localStorage.clear();await getDeviceWorkface().replaceBackup(emptyDeviceWorkface());cleanup=mountThemeRuntime(window)})
afterEach(async()=>{for(const view of mounted.splice(0)){await act(async()=>view.root.unmount());view.element.remove()}cleanup();vi.restoreAllMocks()})
async function custom(){const theme=structuredClone(GRAPHITE_THEME);theme.id='custom.mobile-disclosures';theme.name='Mobile details';theme.icons={'navigation.disclosure':{kind:'paths',paths:[{d:'M12 3L21 20H3Z'}]}};await act(async()=>{expect(previewTheme(theme).applied).toBe(true)})}
it('actual Mobile Goal native details retain their content and keyboard target with a single shared disclosure projection',async()=>{
 expect(goalsCSS).not.toMatch(/\.mobile-goals\s+(?:details\[open\]\s*>\s*)?summary::(?:before|after)/);const f=fixture();f.client.forwardRpc=vi.fn(async(method:string)=>method==='goal.ls'?{goals:[]}:method==='space.ls'?{catalog:{agentPresentation:[]}}:method==='app.snapshot'?{projects:[],sessions:[],unavailable:[]}:{});const view=await mount(<MobileGoalsSurface client={f.client} connected visible/>),summary=view.element.querySelector<HTMLElement>('summary')!,details=summary.parentElement as HTMLDetailsElement;expect(summary,'actual nonempty Goal disclosure').not.toBeNull();expect(summary.querySelector('svg')).toBeNull();const text=summary.textContent
 await custom();expect(view.element.querySelector('summary')).toBe(summary);expect(decodeURIComponent(document.documentElement.style.getPropertyValue('--native-disclosure-mask'))).toContain('M12 3L21 20H3Z');await click(summary);expect(details.open).toBe(true);expect(summary.textContent).toBe(text);expect(details.querySelector('input,select,textarea')).not.toBeNull();await click(summary);expect(details.open).toBe(false)
})
it('actual unknown prompt delivery keeps its original request and draft while send details use the shared disclosure',async()=>{
 expect(conversationCSS).not.toMatch(/\.mobile-send-status\s+(?:details\[open\]\s*>\s*)?summary::(?:before|after)/);const f=fixture();f.submit.mockRejectedValueOnce(Object.assign(Error('Original dispatch acknowledgement unavailable'),{code:'STALE_AGENT_SESSION'}));const view=await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={{state:'connected',message:'Original Host connection'}} platform={createBrowserPlatform()}/>);await paste(view.element,'Original unsent prompt');await click(button(view.element,'Send'));expect(f.submit).toHaveBeenCalledOnce();const input=f.submit.mock.calls[0]![0],summary=view.element.querySelector<HTMLElement>('.mobile-send-status summary')!,details=summary.parentElement as HTMLDetailsElement;expect(summary,'actual nonempty unknown send details').not.toBeNull();expect(summary.querySelector('svg')).toBeNull();expect(view.element.textContent).toContain('发送结果未确认');const original=editor(view.element)
 await custom();expect(view.element.querySelector('.mobile-send-status summary')).toBe(summary);expect(editor(view.element)).toBe(original);expect(original.textContent).toContain('Original unsent prompt');await click(summary);expect(details.open).toBe(true);expect(details.textContent).toContain(input.operationId);await click(summary);expect(details.open).toBe(false);expect(f.submit).toHaveBeenCalledOnce()
})
