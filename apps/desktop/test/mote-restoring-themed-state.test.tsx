// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach,beforeEach,expect,it } from 'vitest'
import { GRAPHITE_THEME,previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { createMoteApp,settleMoteApp,type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab } from './fixtures/mote-workface'
let app:MoteAppFixture
beforeEach(()=>{app=createMoteApp()});afterEach(async()=>{await app.dispose()})
it('the actual Mote chooser themes a retained unresolved original Run as unknown without discarding its tab or claiming availability',async()=>{
 await app.mount();await act(async()=>{useAppStore.setState({sessions:[]});requestPmoTeamsTopicFloatingOpen({targetTopicId:PMO_TEAMS_TOPIC_ID,targetTabId:defaultTab.id})});await settleMoteApp();const marker=app.panel().querySelector<HTMLElement>('[data-mote-availability="restoring"]')!;expect(marker,'nonempty actual retained restoring Mote entry').not.toBeNull();expect(marker.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.unknown'));expect(marker.querySelector('svg')?.getAttribute('width')).toBe('7');const original=useAppStore.getState().tabs[defaultTab.id],drafts=useAppStore.getState().agentComposerDrafts,text=marker.parentElement!.textContent
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.mote-restoring';custom.name='Restoring Mote marker';custom.icons={'status.unknown':{kind:'paths',paths:[{d:'M12 3L21 20H3Z'}]}};await act(async()=>{expect(previewTheme(custom).applied).toBe(true)});expect(app.panel().querySelector('[data-mote-availability="restoring"]')).toBe(marker);expect(marker.parentElement!.textContent).toBe(text);expect(document.getElementById(semanticIconHref('status.unknown').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z');expect(useAppStore.getState().tabs[defaultTab.id]).toBe(original);expect(useAppStore.getState().agentComposerDrafts).toBe(drafts);expect(app.stop).not.toHaveBeenCalled()
})
