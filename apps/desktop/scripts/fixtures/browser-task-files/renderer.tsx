import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { BrowserTaskAssetEditor } from '../../../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetRun } from '../../../src/shared/browser-task-assets'
import '../../../src/renderer/src/styles/index.css'
mountThemeRuntime(window,{appAppearance:'dark'})
const proof=(window as any).taskFiles
;(window as any).taskFilesAppearance=(appearance:'dark'|'light')=>updateThemeSelection({appAppearance:appearance})
function Surface({initial,dialogTypes}:{initial:BrowserTaskAsset;dialogTypes:import('@agentmux/core').AgentMuxBrowserDialogType[]}){
 const [asset,setAsset]=useState(initial),[run,setRun]=useState<BrowserTaskAssetRun|null>(null)
 return <main style={{padding:16,maxWidth:720,margin:'0 auto'}}><BrowserTaskAssetEditor dialogTypes={dialogTypes} asset={asset} recording={null} run={run} onImport={()=>{}} onLocateStep={()=>{}} onStop={()=>{}}
 onSaveDraft={async draft=>setAsset(await proof.save(draft))} onSaveVersion={async draft=>setAsset(await proof.publish(draft))}
 onRun={async(input,event)=>{if(!event.nativeEvent.isTrusted)throw Error('Private proof needs real native input');setRun(await proof.run(input))}} /></main>
}
proof.initial().then(({asset,dialogTypes}:any)=>createRoot(document.getElementById('root')!).render(<Surface initial={asset} dialogTypes={dialogTypes}/>))
