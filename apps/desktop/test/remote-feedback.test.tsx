// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentExecutionInspection } from '@agentmux/core'
import { AgentToolExecutionNotice } from '../src/renderer/src/components/AgentToolExecutionNotice'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const session = { ...composerSession('original'), toolExecution: { bindingId:'original-binding',resourceHostId:'tools',workspacePath:'/project' } }
const fact = ():AgentExecutionInspection => ({bindingId:'original-binding',agentHostId:'local',agentSessionId:'original',resourceHostId:'tools',resourceWorkspacePath:'/project',state:'connected'})
const primary = () => dom.container.querySelector<HTMLElement>('.tool-execution-summary')!
async function click(text:string){const button=[...dom.container.querySelectorAll('button')].find(v=>v.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click())}
it('connected tools keep optional unconfigured and unverified facts in closed details without a fault wall',async()=>{
 vi.spyOn(api.sessions,'observeExecutionBinding').mockImplementation((_id,emit)=>{emit({...fact(),notices:[
  {providerId:'fixture',role:'executor',capability:'agent-control',state:'unconfigured',code:'NO_CONTROL',message:'Original control not configured.',action:'Inspect its original endpoint.'},
  {providerId:'fixture',role:'executor',capability:'hooks',state:'unverified',code:'NOT_VERIFIED',message:'Original hook not verified.',action:'Read its original details.'}
 ]});return vi.fn()})
 const rejoin=vi.spyOn(api.sessions,'rejoinExecutionBinding'),launch=vi.spyOn(api.sessions,'launchAgent'),before=useAppStore.getState()
 await dom.render(<AgentToolExecutionNotice session={session} visible presentation="inline"/>)
 expect(primary().textContent).toBe('Project tools are connected.')
 const details=dom.container.querySelector<HTMLDetailsElement>('.tool-execution-details')!
 expect(details.open).toBe(false)
 expect(details.textContent).toContain('Original control not configured.');expect(details.textContent).toContain('Original hook not verified.')
 await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'))})
 expect(rejoin).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled()
 expect(useAppStore.getState().sessions).toBe(before.sessions);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('helper unavailability describes project tools without inventing Agent death or confirmed health',async()=>{
 vi.spyOn(api.sessions,'observeExecutionBinding').mockImplementation((_id,emit)=>{emit({...fact(),state:'unavailable',diagnostic:{code:'HELPER_MISSING',message:'Original helper Runtime is not available.'}});return vi.fn()})
 const rejoin=vi.spyOn(api.sessions,'rejoinExecutionBinding')
 await dom.render(<AgentToolExecutionNotice session={session} visible presentation="inline"/>)
 expect(primary().textContent).toContain('connection to this project’s tools is unavailable')
 expect(primary().textContent).not.toMatch(/Agent.*(dead|stopped|healthy|available)/)
 expect(dom.container.querySelector('.tool-execution-details')!.textContent).toContain('Original helper Runtime is not available.')
 expect(dom.container.querySelector('.tool-execution-details')!.textContent).not.toContain('The Agent and terminal remain available')
 expect(dom.container.querySelector('.tool-execution-details')!.textContent).toContain('does not confirm running or input availability')
 expect(rejoin).not.toHaveBeenCalled()
})
it('a failed last reconnect stays historical when a fresh observation confirms the original connection',async()=>{
 let emit!:(value:AgentExecutionInspection)=>void
 vi.spyOn(api.sessions,'observeExecutionBinding').mockImplementation((_id,listener)=>{emit=listener;listener({...fact(),state:'unavailable'});return vi.fn()})
 const rejoin=vi.spyOn(api.sessions,'rejoinExecutionBinding').mockRejectedValue(Error('Historical reconnect failed'))
 const read=vi.spyOn(api.sessions,'executionBinding').mockResolvedValue(fact())
 await dom.render(<AgentToolExecutionNotice session={session} visible presentation="inline"/>)
 await click('Reconnect original tools');expect(rejoin).toHaveBeenCalledExactlyOnceWith('original-binding')
 await click('Refresh observation');expect(read).toHaveBeenCalledExactlyOnceWith('original-binding')
 expect(primary().textContent).toBe('Project tools are connected.')
 expect(dom.container.querySelector('.tool-execution-details')!.textContent).toContain('Historical reconnect failed')
 await act(async()=>emit({...fact(),notices:[]}))
 expect(primary().textContent).toBe('Project tools are connected.');expect(rejoin).toHaveBeenCalledTimes(1)
})
it('an unavailable read keeps last-confirmed details while the main status remains unknown',async()=>{
 vi.spyOn(api.sessions,'observeExecutionBinding').mockImplementation((_id,emit,fail)=>{emit(fact());fail('Read failed but no process fact changed');return vi.fn()})
 await dom.render(<AgentToolExecutionNotice session={session} visible presentation="inline"/>)
 expect(primary().textContent).toContain('status is unknown')
 expect(dom.container.querySelector('.tool-execution-details')!.textContent).toContain('Last confirmed tool connection: connected')
 expect(primary().textContent).not.toContain('are connected')
})

it('late reconnect feedback from another binding cannot replace the current object or its healthy tools',async()=>{
 let reject!:(error:Error)=>void
 const task=new Promise<AgentExecutionInspection>((_done,no)=>{reject=no})
 vi.spyOn(api.sessions,'observeExecutionBinding').mockImplementation((id,emit)=>{emit({...fact(),bindingId:id,state:id==='original-binding'?'unavailable':'connected'});return vi.fn()})
 const rejoin=vi.spyOn(api.sessions,'rejoinExecutionBinding').mockReturnValue(task)
 await dom.render(<AgentToolExecutionNotice session={session} visible presentation="inline"/>)
 await click('Reconnect original tools')
 const other={...session,toolExecution:{...session.toolExecution,bindingId:'other-binding'}}
 await dom.render(<AgentToolExecutionNotice session={other} visible presentation="inline"/>)
 await act(async()=>reject(Error('Late original-route failure')))
 expect(primary().textContent).toBe('Project tools are connected.')
 expect(dom.container.textContent).not.toContain('Late original-route failure')
 expect(rejoin).toHaveBeenCalledExactlyOnceWith('original-binding')
})
