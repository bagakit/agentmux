import { createRoot } from 'react-dom/client'
import { FileSurfaceView } from '../../../src/renderer/src/components/FileSurfaceView'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

const tabId='retained-book-tab',regionId='retained-book-region'
let root=createRoot(document.getElementById('root')!),dispose: (()=>void)|undefined
mountThemeRuntime(window,{appAppearance:'dark'})
function Workface(){
  const tab=useAppStore(state=>state.tabs[tabId]),visible=useAppStore(state=>state.mainSurface==='workbench')
  const surface=tab?.regions[regionId]
  return surface?.kind==='file' ? <FileSurfaceView tabId={tabId} surface={surface} visible={visible}/> : <div data-missing-file>Original File unavailable</div>
}
Object.assign(window,{
  async bootBookRestart(mode:string){
    dispose=await useAppStore.getState().initialize()
    if(mode==='writer'){
      const workspace=useAppStore.getState().config!.workspaces[0]!
      let tab=createWorkbenchTab(tabId,{regionId,kind:'file',workspaceId:workspace.id,path:'long.epub'})
      tab=addWorkbenchRegion(tab,regionId,'right',{regionId:'retained-neighbor',kind:'file',workspaceId:workspace.id,path:'neighbor.txt'})
      const layout=createWorkspaceLayout('retained-group',[tabId])
      useAppStore.setState({tabs:{[tabId]:tab},layouts:{[workspace.id]:layout},activeWorkspaceId:workspace.id,mainSurface:'workbench',
        agentComposerDrafts:{'retained-input':'An unsent draft survives the book restart'}})
    }
    root.render(<Workface/>)
  },
  inspectBookRestart(){const state=useAppStore.getState(),frame=document.querySelector('iframe');return {loading:state.loading,tab:state.tabs[tabId],layout:state.layouts[state.activeWorkspaceId!],activeWorkspaceId:state.activeWorkspaceId,mainSurface:state.mainSurface,reading:(()=>{const value=Object.values(state.fileViewReading).find(value=>value.owner.regionId===regionId);return value?{owner:value.owner,position:value.position,phase:value.phase,pending:value.pending,input:value.input,acknowledged:value.acknowledged}:null})(),draft:state.agentComposerDrafts['retained-input'],bookState:document.querySelector('.book-reader')?.getAttribute('data-book-state'),text:frame?.contentDocument?.body?.textContent?.slice(0,200),scroll:frame?.contentDocument?.scrollingElement?.scrollTop,error:state.error,saveWarning:state.workbenchSaveWarning}},
  async checkpointBookRestart(){await prepareRendererUpdate('reload')},
  showBookRestart(){useAppStore.setState({mainSurface:'workbench'})},
  hideBookRestart(){useAppStore.setState({mainSurface:'focus'})},
  async closeBookRestart(){root.unmount();await prepareRendererUpdate('quit');dispose?.()},
})
