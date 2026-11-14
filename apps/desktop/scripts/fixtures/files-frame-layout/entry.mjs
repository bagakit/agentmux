// Reuse the complete production App and ordinary initialization, with its original private Tabs.
import '../mote-shared-space-frame/entry.mjs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { fileUploadRevision, parseFileReadResult, parseFileMkdirParams, parseFileMutationInspectResult } from '@agentmux/core/files'
const state=useAppStore.getState(),workspace=state.config.workspaces.find(value=>value.id===SCRATCH_WORKSPACE_ID)
if(!workspace||!state.tabs['ordinary-topic-tab']||!state.sessions.some(value=>value.id==='ordinary-worker'))throw Error('Original ordinary Topic workface is required')
const calls=[],legacyList=api.files.readDirectory,legacyRead=api.files.read,resource={hostId:workspace.hostId,workspaceId:workspace.id,workspacePath:workspace.path,zoneId:'private-original-files-zone',zonePath:workspace.path,logicalDirectory:'',path:'.'}
const target={hostId:workspace.hostId,expectedRuntimeId:'private-original-source-runtime'}
const locator={mount:{hostId:workspace.hostId,reference:{runtimeId:target.expectedRuntimeId,spaceId:'private-original-files-space'},zoneId:resource.zoneId,workspaceId:workspace.id},resource}
api.sourceFiles.resolve=async(originalTarget,selection)=>{calls.push({operation:'resolve',target:structuredClone(originalTarget),selection:structuredClone(selection)});return {status:'located',locator:structuredClone(locator)}}
api.sourceFiles.watch=async(originalTarget,params)=>({initial:{resource,delivery:'live-only'},start:async()=>{calls.push({operation:'watch',target:structuredClone(originalTarget),params:structuredClone(params)})},dispose(){}})
api.sourceFiles.call=async(originalTarget,method,params)=>{
  calls.push({operation:method,target:structuredClone(originalTarget),params:structuredClone(params)})
  const originalResource={...resource,path:params.path}
  // This preload port has already decoded the packet in production; its Node-only byte budget codec is preflighted in Node.
  if(method==='file.list')return {carrierCurrent:true,result:{resource:originalResource,result:{status:'directory-listed',entries:await legacyList(workspace.id,params.path==='.'?'':params.path),complete:true,partialReason:null}}}
  if(method==='file.read'){
    const result=await legacyRead(workspace.id,params.path)
    if(result.status==='read')result.document.revision=fileUploadRevision(new TextEncoder().encode(result.document.content))
    return {carrierCurrent:true,result:parseFileReadResult({resource:originalResource,result},params)}
  }
  if(method==='file.mutation.inspect')return {carrierCurrent:true,result:parseFileMutationInspectResult({operationId:params.operationId,resource:params.expectedResource,result:{action:'unknown',phase:'unavailable',filesystem:'unknown',durability:'unconfirmed',code:'PRIVATE_SOURCE_OBSERVATION_UNAVAILABLE',message:'The original source operation remains unconfirmed; no mutation was repeated.'}},params)}
  throw Error('Only original read-only Source observations are in this layout proof: '+method)
}
const selected={workspace:{id:workspace.id,hostId:workspace.hostId,path:workspace.path},target,selection:{kind:'directory',path:workspace.path},locator}
window.sharedFrameProof.setFloating({open:false,preview:false})
useAppStore.setState({sourceFilesInputs:{selections:{[workspace.id]:selected},pending:{},creations:{},folderRequests:{}},toolDockWidth:420})
useAppStore.getState().activateTab(workspace.id,'original-mote-first','ordinary-topic-tab')
useAppStore.getState().setWorkspaceTool('files-branches')
if(!useAppStore.getState().toolsOpen)useAppStore.getState().toggleTools()
useAppStore.getState().setExplorerCollapsed(workspace.id,false)
window.filesFrameLayout={ready:true,calls,
  service(nonempty){
    const current=useAppStore.getState(),operationId='original-retained-files-operation'
    const witness={device:'1',inode:'2',size:'0',ctimeNs:'1',mtimeNs:'1',birthtimeNs:null}
    const request=parseFileMkdirParams({zoneId:resource.zoneId,path:'original-retained-folder',operationId,expectedResource:{...resource,path:'original-retained-folder'},expectedAbsent:true,expected:{root:witness,parent:{...witness,inode:'3'}}})
    const pending=nonempty?{[operationId]:{action:'mkdir',workspace:selected.workspace,target,request,issue:'The original Source operation reply is unconfirmed. Check this retained request without repeating it.'}}:{}
    useAppStore.setState({sourceFilesInputs:{...current.sourceFilesInputs,pending}})
  },
  facts(){const current=useAppStore.getState();return {original:window.sharedFrameProof.facts(),sourceFilesInputs:structuredClone(current.sourceFilesInputs),sourceCalls:structuredClone(calls)}}
}
