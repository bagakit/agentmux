import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { fixture, mounted, mount, paste, editor } from './conversation-fixture'
let cleanup: () => void
beforeEach(() => { cleanup = mountThemeRuntime(window) })
afterEach(async () => { for(const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; cleanup(); vi.unstubAllGlobals() })
it('the actual phone conversation themes only the confirmed working glyph while retaining the original Session, editable draft and label', async () => {
  const f=fixture(), original=f.sessions.get('session-original')!
  original.semanticStatus={state:'working',source:'native-hook',observedAt:_reshape_fixtureEpoch(0, 0, 1)}
  const props={client:f.client,agentSessionId:original.agentSessionId,connection:{state:'connected' as const,message:'Original Host'},platform:createBrowserPlatform()}
  const view=await mount(<MobileConversationSurface {...props}/>)
  const state=view.element.querySelector<HTMLElement>('.mobile-active-state')!, icon=state.querySelector('svg')!
  expect(state,'nonempty confirmed state consumer').not.toBeNull();expect(state.textContent).toBe('正在执行');expect(icon.getAttribute('width')).toBe('5');expect(state.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.presence-working'))
  await paste(view.element,'Retained phone draft\n  Original bytes.');const composer=editor(view.element)
  const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.phone-working';custom.name='Phone working';custom.icons={'status.presence-working':{kind:'paths',paths:[{d:'M12 3L21 20H3Z',fill:'currentColor'}]}}
  await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
  expect(view.element.querySelector('.mobile-active-state')).toBe(state);expect(state.querySelector('svg')).toBe(icon);expect(state.textContent).toBe('正在执行');expect(document.getElementById(semanticIconHref('status.presence-working').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z')
  expect(editor(view.element)).toBe(composer);expect(composer.textContent).toContain('Retained phone draft');expect(f.client.agentSession(original.agentSessionId)).toBe(original);expect(f.submit).not.toHaveBeenCalled()
})
