// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../src/shared/contracts'

// The real Panel and Store consume the shared Card directly; no full Workbench or terminal mock is needed.
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root
let consoleErrors: unknown[][]
function composerSession(): Extract<SessionSnapshot,{kind:'agent'}> {
  return { id:'agent-1',kind:'agent',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:'/',
    promptSubmissionPredecessor:null,agentSessionUpdatedAt:1,label:'Workspace review',createdAt:1,updatedAt:1,latestOutputBytes:0,processState:'running',
    status:{state:'running',source:'run-process',observedAt:1},
    capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},
    control:{kind:'agent',hostId:'local',agentSessionId:'agent-1',run:{runId:'run-agent-1'}} }
}
const pending = () => ({ ...composerSession(),status:{state:'waiting' as const,source:'native-hook' as const,observedAt:2},
  pendingInteraction:{kind:'permission' as const,id:'permission-1',agentSessionId:'agent-1',title:'Allow a change?',
    options:[{id:'once',label:'Allow once',kind:'allow-once' as const}],
    evidence:{source:'native-hook' as const,observedAt:2,run:{runId:'run-agent-1'},hookReceiptId:'receipt-1'}} })
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  consoleErrors=[];vi.spyOn(console,'error').mockImplementation((...args)=>{consoleErrors.push(args)})
  const config=await api.config.get()
  config.workspaces=config.workspaces.map((workspace,index)=>({...workspace,path:index===0?'/':'/fixture/workspace-'+index,...(workspace.repoPath?{repoPath:'/fixture/project-'+index}:{})}))
  useAppStore.setState({config,sessions:[composerSession()],error:null,viewModes:{},activeWorkspaceId:config.workspaces[0]!.id})
})
afterEach(async () => { await act(async()=>root.unmount());container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();expect(consoleErrors).toEqual([]) })
const dom = { get container(){return container},render:async(content:import('react').ReactNode)=>{await act(async()=>root.render(content))},
  click:async(selector:string)=>{const button=container.querySelector<HTMLButtonElement>(selector);expect(button).not.toBeNull();await act(async()=>button!.click())} }

it('the attention view keeps a request from an earlier Run readable but unanswerable, as the Session card does', async () => {
  const session = pending()
  const respond = vi.spyOn(api.sessions, 'respondInteraction')
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  // The Session already runs a newer Run; the request's own evidence still names the earlier one.
  useAppStore.setState({ sessions: [{ ...session, control: { ...session.control, run: { runId: 'run-agent-2' } } } as never] })
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  const allow = [...dom.container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')].find(button => button.textContent?.includes('Allow once'))
  expect(allow, dom.container.textContent ?? '').toBeDefined()
  expect(allow!.disabled).toBe(true)
  expect(dom.container.textContent).toContain('Allow a change?')
  await act(async () => allow!.click())
  expect(respond).not.toHaveBeenCalled()
  expect(document.activeElement?.closest('.attention-request-panel__header')).not.toBeNull()
  const open = [...dom.container.querySelectorAll<HTMLButtonElement>('.attention-request-panel__header button')].find(button => button.textContent?.trim() === 'Open Session')!
  await act(async () => open.click())
  expect(select).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(useAppStore.getState().sessions[0]).toMatchObject({ pendingInteraction: session.pendingInteraction })
})

it('opening the attention view puts keyboard focus inside the request, on its safe first action', async () => {
  useAppStore.setState({ sessions: [pending()] })
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  const focused = document.activeElement as HTMLElement | null
  // The request's own row receives focus, not the header's Open Session; its first action is the non-granting Cancel.
  expect(focused?.closest('.agent-interaction'), focused?.outerHTML ?? 'nothing focused').not.toBeNull()
  expect(focused?.textContent?.trim()).toBe('Cancel')
})

it('attention craft keeps current Run input available when auxiliary observation or request Run evidence is unknown', async () => {
  const session = pending()
  const { run: _run, ...evidence } = session.pendingInteraction.evidence
  const request = { ...session.pendingInteraction, evidence }
  useAppStore.setState({ sessions: [{ ...session, pendingInteraction: request,
    timelineObservation: { run: session.control.run, code: 'OBSERVATION_UNAVAILABLE', message: 'Retained history observation is unavailable.' } }] })
  const respond = vi.spyOn(api.sessions, 'respondInteraction').mockResolvedValue(undefined)
  await dom.render(<AttentionRequestPanel sessionId={session.id} onClose={() => {}} />)
  const allow = dom.container.querySelector<HTMLButtonElement>('.agent-interaction__actions .is-primary')!
  expect(allow.disabled).toBe(false)
  await act(async () => allow.click())
  expect(respond).toHaveBeenCalledOnce()
  expect(respond.mock.calls[0]![0]).toEqual(session.control)
  expect(respond.mock.calls[0]![1]).toEqual({ kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'once' } })
  expect(useAppStore.getState().sessions[0]).toMatchObject({ pendingInteraction: request })
})

it('attention craft starts scoped permission on Cancel rather than the first grant', async () => {
  const session = pending()
  useAppStore.setState({ sessions: [{ ...session, pendingInteraction: { ...session.pendingInteraction,
    options: [...session.pendingInteraction.options, { id: 'always', label: 'Allow for this Session', kind: 'allow-always' }] } }] })
  const respond = vi.spyOn(api.sessions, 'respondInteraction')
  await dom.render(<AttentionRequestPanel sessionId={session.id} onClose={() => {}} />)
  expect(dom.container.querySelector('.agent-interaction__grants')).not.toBeNull()
  expect(document.activeElement).toBe(dom.container.querySelector('.agent-interaction__dismiss'))
  expect(respond).not.toHaveBeenCalled()
})

it('attention craft starts questions on Cancel before an answer can be sent', async () => {
  const session = pending()
  useAppStore.setState({ sessions: [{ ...session, pendingInteraction: { kind: 'question', id: 'question-one', agentSessionId: session.id,
    questions: [{ id: 'choice', prompt: 'Choose the target.', options: [{ id: 'first', label: 'Target one' }, { id: 'second', label: 'Target two' }] }],
    evidence: session.pendingInteraction.evidence } }] })
  const respond = vi.spyOn(api.sessions, 'respondInteraction')
  await dom.render(<AttentionRequestPanel sessionId={session.id} onClose={() => {}} />)
  expect(dom.container.querySelector('.agent-interaction__options')).not.toBeNull()
  expect(document.activeElement).toBe(dom.container.querySelector('.agent-interaction__dismiss'))
  expect(respond).not.toHaveBeenCalled()
})

it('attention craft uses the header when native confirmation prevents card decisions and keeps Open terminal available', async () => {
  const session = { ...pending(), interactionResponseUnavailableReason: 'The original native response is still being checked.' }
  useAppStore.setState({ sessions: [session] })
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await dom.render(<AttentionRequestPanel sessionId={session.id} onClose={() => {}} />)
  expect(document.activeElement?.closest('.attention-request-panel__header')).not.toBeNull()
  await dom.click('.agent-interaction__native-terminal')
  expect(useAppStore.getState().viewModes[session.id]).toBe('terminal')
  expect(select).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(useAppStore.getState().sessions[0]).toMatchObject({ pendingInteraction: session.pendingInteraction })
})

it('attention craft preserves existing panel focus when a replacement request arrives', async () => {
  useAppStore.setState({ sessions: [pending()] })
  await dom.render(<AttentionRequestPanel sessionId="agent-1" onClose={() => {}} />)
  const header = dom.container.querySelector<HTMLButtonElement>('.attention-request-panel__header button')!
  header.focus()
  const next = pending(); next.pendingInteraction.id = 'next-question'
  await act(async () => useAppStore.setState({ sessions: [next] }))
  expect(document.activeElement).toBe(header)
  expect(dom.container.querySelector('[data-request-id="next-question"]')).not.toBeNull()
})
