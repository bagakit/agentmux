// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { WorkflowCard } from '../src/renderer/src/components/workflow/WorkflowCard'
import { WorkflowStatusGlyph } from '../src/renderer/src/components/workflow/WorkflowStatusGlyph'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom=composerDOM();let cleanup:()=>void
beforeEach(()=>{cleanup=mountThemeRuntime(window)})
afterEach(()=>cleanup())
it('the actual workflow glyph consumes shared drawing and style while keeping recorded versus streaming and status semantics',async()=>{
 await dom.render(<><WorkflowStatusGlyph status="running" size={16}/><WorkflowStatusGlyph status="running" size={16} recorded/>{(['completed','failed','killed','paused','queued'] as const).map(status=><WorkflowStatusGlyph key={status} status={status} size={12}/>)}</>)
 const running=[...dom.container.querySelectorAll<SVGSVGElement>('.wf-ico--running')]
 expect(running).toHaveLength(2);expect(running[0]!.classList.contains('wf-streaming-glyph')).toBe(true);expect(running[1]!.classList.contains('wf-streaming-glyph')).toBe(false)
 for(const svg of running){expect(svg.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.workflow-running'));expect(svg.getAttribute('width')).toBe('16');expect(svg.style.strokeWidth).toBe('var(--icon-stroke-width, 1.75)')}
 const symbol=document.getElementById(semanticIconHref('status.workflow-running').slice(1))!,defaultGeometry=symbol.innerHTML
 expect(symbol.querySelectorAll('circle')).toHaveLength(2);expect(symbol.querySelector('circle:last-child')?.getAttribute('stroke-linecap')).toBeNull()
 for(const status of ['completed','failed','killed','paused','queued'] as const)expect(dom.container.querySelector(`.wf-ico--${status} use`)?.getAttribute('href')).toBe(semanticIconHref(`status.${status}`))
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.workflow-style';custom.name='Workflow style';custom.iconStyle={strokeWidth:2.5,linecap:'square',linejoin:'bevel'}
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(document.documentElement.style.getPropertyValue('--icon-stroke-width')).toBe('2.5');expect(document.documentElement.style.getPropertyValue('--icon-linecap')).toBe('square');expect(running[0]!.style.strokeWidth).toBe('var(--icon-stroke-width, 1.75)');expect(document.getElementById(symbol.id)).toBe(symbol)
 custom.icons={'status.workflow-running':{kind:'paths',paths:[{d:'M4 4H20V20H4Z'}]}}
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(dom.container.querySelector('.wf-ico--running')).toBe(running[0]);expect(document.getElementById(symbol.id)?.innerHTML).not.toBe(defaultGeometry);expect(document.getElementById(symbol.id)?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z');expect(running[1]!.classList.contains('wf-streaming-glyph')).toBe(false)
})

it('the actual workflow card and agent row retain disclosure and original model while their running shapes change',async()=>{
 const workflow:import('../src/renderer/src/components/workflow/types').WorkflowSnapshot={id:'original-workflow',name:'Original workflow',status:'running',completedAgents:0,totalAgents:1,duration:'1m',tokens:'120',toolCalls:2,phases:[{id:'original-phase',label:'Original phase',status:'running',completed:0,total:1,elapsed:'1m',agents:[{id:'original-agent',label:'Original agent',status:'running',model:'Original model',lastTool:'Original tool'}]}]}
 await dom.render(<WorkflowCard workflow={workflow}/>)
 const head=dom.container.querySelector<HTMLButtonElement>('.wf-head')!,agent=dom.container.querySelector<HTMLButtonElement>('.wf-agent__button')!,icon=head.querySelector('.wf-ico--running')!
 expect(agent,'actual nonempty nested agent caller').not.toBeNull();expect(icon.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.workflow-running'))
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.workflow-card';custom.name='Workflow card';custom.icons={'status.workflow-running':{kind:'paths',paths:[{d:'M4 4H20V20H4Z'}]}}
 await act(async()=>{expect(previewTheme(custom).applied).toBe(true)})
 expect(dom.container.querySelector('.wf-head')).toBe(head);expect(head.querySelector('.wf-ico--running')).toBe(icon);expect(head.getAttribute('aria-expanded')).toBe('true');expect(dom.container.textContent).toContain('Original workflow');expect(workflow.phases[0]!.agents[0]!.status).toBe('running')
 await act(async()=>agent.click());expect(agent.getAttribute('aria-expanded')).toBe('true');expect(dom.container.querySelector('.wf-detail')?.textContent).toContain('Original model');await act(async()=>head.click());expect(head.getAttribute('aria-expanded')).toBe('false');expect(dom.container.querySelector('.wf-body')).toBeNull()
})
