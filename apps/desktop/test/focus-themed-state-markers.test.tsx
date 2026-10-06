// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom=composerDOM();let cleanup:()=>void
beforeEach(()=>{cleanup=mountThemeRuntime(window)})
afterEach(()=>cleanup())
it('the actual Focus live Run and legend theme their drawings without changing the original navigation, time or process facts',async()=>{
 const now=Date.now(),original=composerSession('original-focus-run'),select=vi.fn()
 original.semanticStatus={state:'working',source:'native-hook',observedAt:now,stateEnteredAt:now-60000}
 useAppStore.setState({sessions:[original],timelines:{},focusTimelineMode:'expanded'})
 const state=useAppStore.getState(),contexts=createFocusProjectionSelector()({sessions:state.sessions,config:state.config,timelines:state.timelines,agentNames:state.agentNames,scratchTopicSnapshots:state.scratchTopicSnapshots}).contexts
 expect(contexts,'nonempty original Focus context projection').toHaveLength(1)
 await dom.render(<RecentFocusTimeline contexts={contexts} entries={[{sessionId:original.id,focusedAt:now-60000}]} currentSessionId={original.id} onSelect={select}/>)
 const live=dom.container.querySelector<HTMLButtonElement>('.recent-focus__live')!
 expect(live,'nonempty original live Run control').not.toBeNull();expect(dom.container.querySelectorAll('.recent-focus__working svg')).toHaveLength(0);expect(live.dataset.runId).toBe(original.control.run.runId);expect(live.dataset.runState).toBe('running')
 expect(live.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.presence-running'));expect(live.querySelector('svg')?.getAttribute('width')).toBe('6')
 const legend=dom.container.querySelector('[data-focus-fact="alive"]')!
 expect(legend,'nonempty live Run legend').not.toBeNull();expect(legend.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.presence-running'))
 const label=live.getAttribute('aria-label'),position=live.style.left,custom=structuredClone(GRAPHITE_THEME);custom.id='custom.focus-live';custom.name='Focus live';custom.icons={'status.presence-running':{kind:'paths',paths:[{d:'M4 4H20V20H4Z'}]}}
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(dom.container.querySelector('.recent-focus__live')).toBe(live);expect(live.getAttribute('aria-label')).toBe(label);expect(live.style.left).toBe(position)
 expect(document.getElementById(semanticIconHref('status.presence-running').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
 await act(async()=>live.click());expect(select).toHaveBeenCalledExactlyOnceWith(contexts[0]!.id);expect(useAppStore.getState().sessions[0]).toBe(original)
})
it('an actual typed history-gap observation renders the unknown marker while retaining the original focus and coverage facts',async()=>{
 const now=Date.now(),original=composerSession('original-gap-run'),item:import('@agentmux/core').AgentTimelineItem={id:'original-observation-gap',agentSessionId:original.id,kind:'lifecycle',status:'complete',source:'run-process',title:'Original typed history gap',createdAt:now-1000,updatedAt:now-1000,activityState:{run:original.control.run,boundary:'history-gap'}}
 const timeline={agentSessionId:original.id,revision:1,items:[item]}
 useAppStore.setState({sessions:[original],timelines:{[original.id]:timeline},focusTimelineMode:'expanded'})
 const state=useAppStore.getState(),contexts=createFocusProjectionSelector()({sessions:state.sessions,config:state.config,timelines:state.timelines,agentNames:state.agentNames,scratchTopicSnapshots:state.scratchTopicSnapshots}).contexts
 await dom.render(<RecentFocusTimeline contexts={contexts} entries={[]} currentSessionId={original.id} onSelect={()=>{}}/>)
 const gap=dom.container.querySelector<HTMLElement>('.recent-focus__work-gap')!
 expect(gap,'nonempty typed gap consumer').not.toBeNull();expect(gap.tabIndex).toBe(0);expect(gap.getAttribute('role')).toBe('img');expect(gap.getAttribute('aria-label')).toContain('working start and end not recorded')
 expect(gap.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.unknown'));expect(gap.querySelector('svg')?.getAttribute('width')).toBe('6')
 const label=gap.getAttribute('aria-label'),position=gap.style.left,custom=structuredClone(GRAPHITE_THEME);custom.id='custom.focus-unknown';custom.name='Focus gap';custom.icons={'status.unknown':{kind:'paths',paths:[{d:'M12 3L21 20H3Z'}]}}
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(dom.container.querySelector('.recent-focus__work-gap')).toBe(gap);expect(gap.getAttribute('aria-label')).toBe(label);expect(gap.style.left).toBe(position)
 expect(document.getElementById(semanticIconHref('status.unknown').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z');expect(useAppStore.getState().timelines[original.id]).toBe(timeline);expect(useAppStore.getState().sessions[0]).toBe(original)
})
