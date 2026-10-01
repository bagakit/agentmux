import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolkitToolDefinition, ToolkitScriptSnapshot } from '@agentmux/core/control'
import { ToolkitStatusBar } from '../src/renderer/src/components/toolkit/ToolkitStatusBar'
import { WindowUtilityBar } from '../src/renderer/src/components/WindowUtilityBar'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom=composerDOM()
const tools:ToolkitToolDefinition[]=Array.from({length:128},(_,index)=>({id:`tool-${index}`,revision:`revision-${index}`,name:`Tool ${index}`,icon:'terminal',enabled:true,statusBar:'icon',workspacePath:_hygiene_fixturePath("work"),script:'console.log(1)',args:[]}))
const sessions=Array.from({length:128},(_,index)=>composerSession(`unrelated-${index}`))
const hosts=[...composerConfig.hosts,...Array.from({length:7},(_,index)=>({id:`host-${index}`,kind:'ssh' as const,label:`Host ${index}`,hostname:`host-${index}.invalid`}))]
const source=(id:string):ToolkitScriptSnapshot=>({schema:'agentmux.toolkit.v1',kind:'script',toolId:id,definition:tools.find(tool=>tool.id===id)!,state:'idle',reason:null,admission:null,latestConfirmed:null,consumerCount:1,sequence:1})
const navigation={open:()=>{},openToolkit:()=>{}} // Same stable Context identity as App's useMemo.
function Footer() {
  // This is the ordinary parent-render pressure from App's Session/Host subscriptions.
  const inputs=useAppStore(state=>state.sessions),configuration=useAppStore(state=>state.config)
  return <footer className="window-status-bar" data-related-sessions={inputs.length} data-hosts={configuration?.hosts.length}><div className="window-status-bar__surface-switch"/><SettingsNavigation.Provider value={navigation}><WindowUtilityBar toolkit={<ToolkitStatusBar/>}/></SettingsNavigation.Provider></footer>
}
beforeEach(()=> {
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}})
  vi.stubGlobal('__ToolkitCostProof',[])
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>setTimeout(()=>callback(1),0));vi.stubGlobal('cancelAnimationFrame',clearTimeout)
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('window-status-bar')?640:0})
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){const width=this.hasAttribute('data-measure-tool')||this.matches('button')?22:this.classList.contains('window-status-bar__surface-switch')?150:0;return new DOMRect(0,0,width,26)})
  useAppStore.setState({config:{...composerConfig,hosts,toolkit:{performance:{enabled:false,statusBar:'icon'},tools}},sessions})
})
describe('Toolkit related consumer cost under a real mounted parent and Store',()=> {
  for(const path of ['direct','overflow'] as const) it(`${path} chosen result does not redraw or renew its lease for 128 unrelated Sessions and 8 Hosts`,async()=> {
    const leases:string[]=[],observe=vi.spyOn(api.toolkit,'observe').mockImplementation((id,read)=>{leases.push(`read:${id}`);read(source(id));return{dispose:()=>leases.push(`release:${id}`)}})
    const get=vi.spyOn(api.toolkit,'get'),run=vi.spyOn(api.toolkit,'run')
    await dom.render(<Footer/>)
    expect(useAppStore.getState().config?.toolkit?.tools).toHaveLength(128)
    expect(useAppStore.getState().sessions).toHaveLength(128)
    expect(useAppStore.getState().config?.hosts).toHaveLength(8)
    expect(document.querySelectorAll('.toolkit-statusbar__measure [data-measure-tool]')).toHaveLength(128)
    const id=path==='direct'?'tool-0':'tool-127'
    if(path==='direct') await dom.click('[data-toolkit-id="tool-0"]')
    else {
      await dom.click('[aria-label="More tools"]')
      const choices=Array.from(document.querySelectorAll<HTMLButtonElement>('.toolkit-overflow__item'))
      expect(choices.length).toBeGreaterThan(0)
      expect(choices.at(-1)?.textContent).toBe('Tool 127')
      await act(async()=>choices.at(-1)!.click())
    }
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector('.toolkit-result__empty')?.textContent).toContain('Hovering only reads')
    expect(leases).toEqual([`read:${id}`]);expect(observe).toHaveBeenCalledOnce()
    const counts=(globalThis as unknown as {__ToolkitCostProof:string[]}).__ToolkitCostProof
    expect(counts.filter(value=>value==='ToolkitStatusBar').length).toBeGreaterThan(0)
    expect(counts.filter(value=>value==='UserToolkitResult').length).toBeGreaterThan(0)
    counts.length=0
    await act(async()=>useAppStore.setState({sessions:sessions.map(session=>({...session,latestOutputBytes:session.latestOutputBytes+1}))}))
    await act(async()=>useAppStore.setState({config:{...useAppStore.getState().config!,hosts:hosts.map(host=>({...host,label:host.label+' updated'}))}}))
    if(process.env.AGENTMUX_TOOLKIT_UI_EVIDENCE) writeFileSync(join(process.env.AGENTMUX_TOOLKIT_UI_EVIDENCE,`cost-${path}.json`),JSON.stringify({path,toolCount:tools.length,sessionCount:sessions.length,hostCount:hosts.length,counts:[...counts],leases:[...leases],reads:observe.mock.calls.length,get:get.mock.calls.length,runs:run.mock.calls.length},null,2)+'\n')
    expect(counts).toEqual([])
    expect(leases).toEqual([`read:${id}`]);expect(observe).toHaveBeenCalledOnce();expect(get).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled()
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-toolkit-close]')!.click())
    expect(leases).toEqual([`read:${id}`,`release:${id}`])
  })
})
