import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { MobileMailbox } from '../src/conversation/MobileMailbox'
import { createBrowserPlatform } from '../src/platform/browser'
import { click, mount, mounted, session } from './conversation-fixture'
const require=createRequire(import.meta.url),postcss=createRequire(realpathSync(require.resolve('vite/package.json')))('postcss')
const css=postcss.parse(readFileSync(require.resolve('../src/conversation/conversation.css'),'utf8'))
function declaration(selector:string,property:string){const values:string[]=[];css.walkRules(selector,(r:any)=>r.walkDecls(property,(d:any)=>values.push(d.value)));return values.at(-1)}
let cleanup:()=>void
beforeEach(()=>{cleanup=mountThemeRuntime(window)})
afterEach(async()=>{await act(async()=>{for(const view of mounted.splice(0)){view.root.unmount();view.element.remove()}});cleanup();document.body.replaceChildren();vi.restoreAllMocks()})
it('the original phone mailbox applies distinct semantic controls and state masks without changing observations or actions',async()=>{
 const original=session(),refresh=vi.fn(),terminal=vi.fn(),overlay=document.createElement('div');document.body.append(overlay)
 const platform=createBrowserPlatform({overlayContainer:()=>overlay}),props={session:original,connected:true,messages:[],platform,describeSpeaker:()=>undefined,refresh,terminal}
 const view=await mount(<MobileMailbox {...props}/>),trigger=view.element.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!,state=trigger.querySelector('i')!
 expect(trigger.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.mailbox'));expect(trigger.getAttribute('aria-label')).toBe('通信记录 · 状态未知');expect(state.dataset.state).toBe('unknown')
 expect(declaration('.mobile-message-tools__trigger i','width')).toBe('5px');expect(declaration('.mobile-message-tools__trigger i','height')).toBe('5px');expect(declaration('.mobile-message-tools__trigger i','mask')).toBe('var(--native-presence-unknown-mask) center / contain no-repeat');expect(declaration('.mobile-message-tools__trigger i','border-radius')).toBeUndefined()
 for(const [value,label] of [['neutral','状态未知'],['working','执行中'],['running','状态未确认'],['starting','启动中'],['waiting','等待输入'],['blocked','需要处理'],['error','出错'],['done','已完成'],['exited','已结束'],['disconnected','状态未知']] as const){
  original.semanticStatus={state:value,source:'run-process',observedAt:_reshape_fixtureEpoch(0, 0, 1)}
  await view.render(<MobileMailbox {...props}/>);expect(trigger.querySelector('i')).toBe(state);expect(state.dataset.state).toBe(value);expect(trigger.getAttribute('aria-label')).toBe(`通信记录 · ${label}`)
  expect(declaration(`.mobile-message-tools__trigger i[data-state='${value}']`,'mask-image')).toBe(`var(--native-presence-${value}-mask)`)
 }
 original.semanticStatus={state:'waiting',source:'native-hook',observedAt:_reshape_fixtureEpoch(0, 0, 1)}
 await view.render(<MobileMailbox {...props}/>);const originalStatus=original.semanticStatus
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.phone-mailbox';custom.name='Phone mailbox';custom.icons={'object.mailbox':{kind:'glyph',glyph:'inbox'},'action.close':{kind:'glyph',glyph:'circle-x'},'action.refresh':{kind:'glyph',glyph:'rotate-ccw'},'object.terminal':{kind:'glyph',glyph:'terminal'},'status.presence-waiting':{kind:'paths',paths:[{d:'M12 3L21 20H3Z',fill:'currentColor'}]}}
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(view.element.querySelector('.mobile-message-tools__trigger')).toBe(trigger);expect(state.dataset.state).toBe('waiting');expect(decodeURIComponent(document.documentElement.style.getPropertyValue('--native-presence-waiting-mask'))).toContain('M12 3L21 20H3Z');expect(original.semanticStatus).toBe(originalStatus)
 await click(trigger);const close=overlay.querySelector('[aria-label="关闭通信记录"]')!,buttons=[...overlay.querySelectorAll('button')]
 expect(close.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.close'))
 const refreshButton=buttons.find(n=>n.textContent?.includes('刷新消息'))!,terminalButton=buttons.find(n=>n.textContent?.includes('查看 Terminal'))!
 expect(refreshButton.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.refresh'));expect(terminalButton.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.terminal'))
 await click(refreshButton);expect(refresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({type:'click',target:refreshButton}));expect(overlay.querySelector('[role=dialog]')).not.toBeNull()
 await click(close);expect(overlay.querySelector('[role=dialog]')).toBeNull();await click(trigger);await click([...overlay.querySelectorAll('button')].find(n=>n.textContent?.includes('查看 Terminal'))!);expect(terminal).toHaveBeenCalledExactlyOnceWith();expect(overlay.querySelector('[role=dialog]')).toBeNull();expect(original.semanticStatus).toBe(originalStatus)
 await view.render(<MobileMailbox {...props} connected={false}/>);expect(trigger.getAttribute('aria-label')).toBe('通信记录 · 连接中断 · 最近状态保留');expect(state.dataset.state).toBe('waiting')
})
