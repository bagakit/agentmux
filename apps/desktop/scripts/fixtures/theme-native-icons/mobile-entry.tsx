import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MobilePrimaryNavigation } from '../../../../mobile/src/navigation/MobilePrimaryNavigation'
import { createBrowserPlatform } from '../../../../mobile/src/platform/browser'
import { ComposerLayoutToggle } from '@agentmux/client-ui/components/ComposerLayoutToggle'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import { WorkflowStatusGlyph } from '@agentmux/client-ui/components/WorkflowObservation'
import { mountThemeRuntime, updateThemeSelection, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import '@agentmux/client-ui/styles.css'
import '../../../../mobile/src/mobile.css'
const disposeRuntime = mountThemeRuntime(window, { appAppearance: 'light' })
if (import.meta.hot) import.meta.hot.dispose(disposeRuntime)
const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.mobile-proof'
custom.icons={ 'object.mote':{kind:'glyph',glyph:'gem'},'object.goal':{kind:'glyph',glyph:'gem'},'status.failed':{kind:'glyph',glyph:'shield-alert'} }
const platform=createBrowserPlatform()
function MobileIcons() {
  const [draft,setDraft]=useState('Draft preserved while changing theme')
  const [current,setCurrent]=useState<'space'|'goals'|'topics'|'mote'|'focus'>('space')
  const [phase,setPhase]=useState<'collapsed'|'current'|'expanded'>('collapsed')
  const [customized,setCustomized]=useState(false)
  return <div className="mobile-app" style={{height:800,width:390,maxWidth:"100%"}}><header className="mobile-header"><MoteIcon size={20}/><strong>Original mobile controls</strong></header>
    <main className="mobile-conversation" style={{gridRow:3,padding:16}}><h1>Theme icons</h1><button className="mobile-text-button" onClick={()=>{const next=!customized;setCustomized(next);updateThemeSelection(next?{themeId:custom.id,appAppearance:'light',customThemes:{[custom.id]:themeValue(custom)}}:{appAppearance:'light'})}}>Switch icon theme</button>
      <p><WorkflowStatusGlyph status="running"/>Producing work · <WorkflowStatusGlyph status="running" recorded/>Recorded running · <WorkflowStatusGlyph status="failed"/>Failed</p>
      <ClientUiProvider platform={platform}><AgentComposer value={draft} onChange={setDraft} disabled={false} placeholder="Original mobile draft" onSubmit={()=>{}} postureTool={<ComposerLayoutToggle phase={phase} onChange={setPhase}/>}/></ClientUiProvider>
      {platform.renderMessageAvatar({speaker:{role:'agent',id:'original-agent'},name:'Original agent'})}
      <output>{current} · {phase} · {customized?'custom':'default'}</output>
    </main><MobilePrimaryNavigation current={current} onSelect={setCurrent}/></div>
}
createRoot(document.getElementById('root')!).render(<MobileIcons/> )
