import { fixturePath as _reshape_fixturePath, fixtureEpoch as _reshape_fixtureEpoch } from "../../../../../test/fixture-values.mjs"
import {createRoot} from 'react-dom/client'
import {DesktopClientUiProvider} from '../../../src/renderer/src/components/DesktopClientUiProvider'
import {HostSettingsPane} from '../../../src/renderer/src/components/settings/HostSettingsPane'
import {ComposerOutbox} from '../../../src/renderer/src/components/ComposerOutbox'
import {BrowserOperationStatus,BrowserOperationTimeline} from '../../../src/renderer/src/components/BrowserOperationSurface'
import {MobileConnectionResult} from '../../../src/renderer/src/components/toolkit/MobileConnectionResult'
import {api} from '../../../src/renderer/src/lib/api'
import {useAppStore} from '../../../src/renderer/src/store'
import {MOBILE_CONNECTION_TOOL_ID} from '../../../src/shared/toolkit-preferences'
import {ConversationMessage} from '@agentmux/client-ui/components/ConversationMessage'
import {NativeProcessObservation} from '@agentmux/client-ui/components/NativeProcessObservation'
import {getThemeCatalog,mountThemeRuntime,themeValue,updateThemeSelection} from '@agentmux/client-ui/theme'
import type {ToolkitScriptSnapshot,ToolkitToolDefinition,ToolkitConfirmedResult} from '@agentmux/core/control'
import type {AgentSessionHistoryItem} from '@agentmux/core'
import type {BrowserOperation} from '../../../src/shared/browser-operation'
import '../../../src/renderer/src/styles/index.css'

const config=await api.config.get();const host=config.hosts[0]!;const calls:unknown[]=[];let clipboardFailure=false;let checkOutcome:'ready'|'unsupported'|'checking'|'check-failed'='ready'
api.ui.writeClipboardText=async text=>{calls.push({method:'writeClipboardText',text,accepted:!clipboardFailure});if(clipboardFailure)throw Error('Private clipboard receipt failed; original link is retained.')}
api.hosts.check=async input=>{calls.push({method:'hosts.check',input,outcome:checkOutcome});if(checkOutcome==='checking')return new Promise(()=>{});if(checkOutcome==='check-failed')throw Error('Private diagnostic could not confirm status; original capabilities retained.');return {input:structuredClone(input),outcome:checkOutcome,detail:'Private original Host check receipt.'}}
useAppStore.setState({config,hostChecks:{},sessions:[]})
const definition:ToolkitToolDefinition={id:MOBILE_CONNECTION_TOOL_ID,revision:'private-source-v1',name:'Phone connection',enabled:true,statusBar:'icon',workspacePath:_reshape_fixturePath("private/theme-success"),script:'readOriginalOwner()',args:[],actions:[]}
const confirmed:ToolkitConfirmedResult={executionId:'private-link-receipt',invocationId:'private-link-request',definition,expectedLatestExecutionId:null,target:{workspacePath:definition.workspacePath},run:{hostId:'local',runId:'private-link-run'},startedAt:_reshape_fixtureEpoch(0, 0, 1),endedAt:_reshape_fixtureEpoch(0, 0, 2),exitCode:0,state:'succeeded',reason:null,document:{schema:'agentmux.toolkit.result.v1',summary:'Private connection observation',items:[],links:[{label:'Original link',url:'http://192.0.2.1:4700/mobile/#offer=private-original'}],notice:''},text:JSON.stringify({schema:'agentmux.toolkit.result.v1',summary:'Private connection observation',items:[],links:[{label:'Original link',url:'http://192.0.2.1:4700/mobile/#offer=private-original'}],notice:''})}
const toolkit:ToolkitScriptSnapshot={schema:'agentmux.toolkit.v1',kind:'script',toolId:definition.id,definition,state:'succeeded',reason:null,admission:null,latestConfirmed:confirmed,consumerCount:1,sequence:1,display:{state:'succeeded',reason:null,admission:null,sequence:1,latestConfirmed:confirmed,lastSucceeded:confirmed}}
api.toolkit.observe=(id,read)=>{if(id!==definition.id)throw Error('Wrong private toolkit');read(toolkit);calls.push({method:'toolkit.observe',id});return{dispose(){calls.push({method:'toolkit.dispose',id})}}}
api.toolkit.get=async()=>toolkit
const operation:BrowserOperation={id:'private-browser-completed',browserId:'private-browser',operator:{id:'private-operator',name:'Original observed operation'},startedAt:_reshape_fixtureEpoch(0, 0, 1),finishedAt:_reshape_fixtureEpoch(0, 0, 2),phase:'completed',summary:'Recorded operation completed; outcome not inferred.',url:'https://example.test/',steps:[{sequence:1,method:'page.read',label:'Original recorded read',startedAt:_reshape_fixtureEpoch(0, 0, 1),finishedAt:_reshape_fixtureEpoch(0, 0, 2),status:'completed'}]}
const item:AgentSessionHistoryItem={id:'private-original-process',kind:'activity',contentParts:[{kind:'text',text:'Original immutable operation record.'}],collaboration:{kind:'operation',operation:'wait',status:'completed',receivers:[{providerId:'codex',nativeSessionId:'private-native-target'}],agentStates:[{source:{providerId:'codex',nativeSessionId:'private-native-target'},state:'completed',message:'Recorded target state; not current Runtime eligibility.'}]},startedAt:_reshape_fixtureEpoch(0, 0, 1),completedAt:_reshape_fixtureEpoch(0, 0, 2)}
const retrofit=getThemeCatalog().items.find(i=>i.id==='retro-future')!.value;const custom={...structuredClone(retrofit),id:'custom.success-proof',name:'Private role propagation'};custom.variants.dark.colors.success='#72c6dd';custom.variants.light.colors.success='#17667d'
mountThemeRuntime(window,{themeId:'retro-future',appAppearance:'dark'})
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><main style={{padding:24,display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
<section aria-label="Original messages"><h2>Clipboard results</h2><ConversationMessage speaker={{role:'agent',id:'private-source-agent'}} conversationSessionId="private-receiver" content="Original message and original sender identity." status="complete" /><ComposerOutbox queued={[{id:'private-retained-message',text:'Original unsent queued bytes.',status:'queued',deliverable:true}]} selectedId="private-retained-message" onSelect={()=>{}} onCopy={async text=>{await api.ui.writeClipboardText(text);return true}} /></section>
<section aria-label="Original host check"><h2>Host check</h2><HostSettingsPane config={{...config,hosts:[host],workspaces:[]}} active onSave={async()=>{throw Error('No private Host writes are authorized by this fixture.')}} /></section>
<section aria-label="Original browser observation"><h2>Browser recorded result</h2><BrowserOperationStatus activity={{operation,control:'human'}}/><BrowserOperationTimeline operation={operation} selectedSequence={1} /></section>
<section aria-label="Original native process"><h2>Recorded target state</h2><NativeProcessObservation id="private-process" items={[item]} renderRecord={(record,wrap)=>wrap(<ConversationMessage content={record.contentParts} />)}/></section>
<section aria-label="Original phone connection" style={{gridColumn:'1 / -1'}}><MobileConnectionResult active close={()=>{calls.push({method:'closePhone'})}}/></section>
</main></DesktopClientUiProvider>)
Object.assign(window,{successProof:{calls,failClipboard(){clipboardFailure=true},checkMode(mode:typeof checkOutcome){checkOutcome=mode},async checkHost(){await useAppStore.getState().checkHost(host)},custom(){updateThemeSelection({themeId:custom.id,customThemes:{[custom.id]:themeValue(custom)}})},mode(appAppearance:'dark'|'light'){updateThemeSelection({appAppearance})},facts(){return {theme:document.documentElement.dataset.theme,mode:document.documentElement.dataset.appearance,success:getComputedStyle(document.documentElement).getPropertyValue('--success').trim(),action:getComputedStyle(document.documentElement).getPropertyValue('--green').trim(),checks:useAppStore.getState().hostChecks,calls}}}})
