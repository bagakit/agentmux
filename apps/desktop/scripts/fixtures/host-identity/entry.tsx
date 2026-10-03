import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { TopRowLeadingChrome } from '../../../src/renderer/src/components/TopRowChrome'
import { WorkspaceBoard } from '../../../src/renderer/src/components/WorkspaceBoard'
import { BoardRowsProvider } from '../../../src/renderer/src/hooks/useBoardRows'
import { WorkspaceSidebar } from '../../../src/renderer/src/components/WorkspaceSidebar'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { projectWorkspaces } from '../../../src/renderer/src/lib/workspace-projects'
import '../../../src/renderer/src/styles/index.css'
const config = await api.config.get()
config.hosts = [{id:'local',kind:'local',label:'Studio'}, {id:'ssh-studio',kind:'ssh',label:'Studio',hostname:'preview.invalid'}, {id:'ssh-long',kind:'ssh',label:'Production Research Workstation Singapore',hostname:'preview.invalid'}]
config.workspaces = ['local','ssh-studio','missing-host','ssh-long'].map((hostId,i)=>({id:`preview-${i}`,kind:'folder',name:i===3?'agentmux-platform-infrastructure':'agentmux',hostId,path:_hygiene_fixturePath("preview/agentmux"),branch:i===3?'feature/remote-host-identity-long-branch':'main'}))
api.config.get = async()=>structuredClone(config)
api.workspaces.appearance = async()=>({kind:'repository',icon:null})
;(window as any).hostIdentityBranchReads=0
;(window as any).hostIdentityRuntimeAttempts=0
api.workspaces.listBranches = async id=>{(window as any).hostIdentityBranchReads++;const w=config.workspaces.find(w=>w.id===id)!;return {kind:'git-repository',hostId:w.hostId,repoPath:w.path,branches:[{name:w.branch!,worktreePath:w.path,workspaceId:id,isCurrent:true}]}}
api.scratch.listTopics = async()=>[]
const base=(await api.sessions.snapshot()).sessions[0]!
const sessions=config.workspaces.map((w,i)=>({...base,id:`preview-session-${i}`,hostId:w.hostId,workspacePath:w.path,label:'Review host identity',processState:'running' as const,status:{state:'working' as const,source:'native-hook' as const,observedAt:Date.now(),detail:'Reading project files'},control:{kind:'agent' as const,hostId:w.hostId,agentSessionId:`preview-session-${i}`,run:{runId:`preview-run-${i}`}}}))
for(const method of ['launchAgent','launchTerminal','write','paste','stop','submitPrompt','submitMessage']) (api.sessions as any)[method]=async()=>{(window as any).hostIdentityRuntimeAttempts++;throw new Error('Capture preview forbids Runtime operations')}
const projects=projectWorkspaces(config.workspaces)
useAppStore.setState({config,sessions,loading:false,mainSurface:'agents',activeWorkspaceId:'preview-0',localHome:_hygiene_fixturePath("preview"),projectGroups:[{groupId:'preview-group',name:'Release devices',projectIds:projects.map(p=>p.id)}],collapsedProjectGroups:{}})
const root=createRoot(document.getElementById('root')!)
;(window as any).hostIdentityScene=(scene:string,index=0)=>{
 useAppStore.setState({activeWorkspaceId:`preview-${index}`,mainSurface:scene==='focus'?'agents':'workbench'})
 root.render(<DesktopClientUiProvider>{scene==='focus'?<GlobalFocusSurface/>:scene==='groups'?<div className="project-rail" style={{width:300,height:'100vh'}}><WorkspaceSidebar visible/></div>:<div style={{height:'100vh',display:'flex',flexDirection:'column'}}><div className="topbar"><TopRowLeadingChrome/></div><BoardRowsProvider enabled><WorkspaceBoard/></BoardRowsProvider></div>}</DesktopClientUiProvider>)
}
;(window as any).hostIdentityScene('focus')
;(window as any).hostIdentityReady=true
