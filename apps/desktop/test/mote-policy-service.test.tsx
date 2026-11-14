// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { act, type ReactNode } from 'react'
import { useMoteMainEntry } from '../src/renderer/src/lib/mote-main-entry'
import { retainMoteMainCreationReference } from '../src/renderer/src/store'
import { moteConnectionTarget } from '../src/renderer/src/lib/mote-connection-default'
import { MoteDialogueViewProvider } from '../src/renderer/src/lib/mote-dialogue-view'
import { moteMainRoleRevision } from '@agentmux/core/mote-dialogue'
import { scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface, installNativePopover } from './fixtures/mote-workface'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string } }) => <div data-terminal-session={session.id} /> }))
const baseline = useAppStore.getState(), launcher = useLauncherState.getState(), closes: Array<() => void | Promise<void>> = []
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(baseline, true); useLauncherState.setState(launcher, true); localStorage.clear() })
function setup(policy:'unconfigured'|'keep-current'|'automatic'|'unconfirmed'='unconfigured') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IntersectionObserver', class { constructor(private notify: IntersectionObserverCallback) {} observe(target: Element) { queueMicrotask(() => this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) } unobserve() {} disconnect() {} })
  localStorage.clear(); seedMoteWorkface(); closes.push(installNativePopover())
  const continuity = { operationId: 'original-recovery', agentSessionId: defaultAgent.id, trigger: 'manual' as const,
    previousRun: defaultAgent.control.run, policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, admittedAt: 1, observedAt: 1, rechecks: 0,
    kind: 'unavailable' as const, reason: 'native-handle-unavailable' as const, evidence: { kind: 'run-ended' as const, state: 'exited' as const, observedAt: 1 } }
  useAppStore.setState(current => ({ loading: false, initialize: async () => () => {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}),
    activeWorkspaceId: scratchWorkspace.id, mainSurface: 'workbench', sessions: current.sessions.map(item => item.id === defaultAgent.id ? {
      ...defaultAgent, processState: 'exited' as const, continuity, status: { state: 'error' as const, source: 'run-process' as const, observedAt: 1, continuity: 'unavailable' as const, continuityReason: 'native-handle-unavailable' as const }
    } : item), viewModes: { [defaultAgent.id]: 'activity' } }))
  useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', defaultTab.id)
  const defaults={conversation:reference,...(policy==='automatic'?{conversationRollover:{kind:'idle' as const,idleMs:60000}}:policy==='keep-current'?{conversationRollover:{kind:'keep-current' as const}}:{})}
  const topics=moteTopics.map((value,index)=>index?value:{...value,quickMode:policy==='unconfirmed'?{status:'unconfirmed' as const,message:'Original settings unavailable'}:{status:'saved' as const,version:'original-file',defaults}})
  useAppStore.setState(state=>({scratchTopicSnapshots:{...state.scratchTopicSnapshots,[scratchWorkspace.id]:{...state.scratchTopicSnapshots[scratchWorkspace.id]!,topics}}}))
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics); vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  const read = vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }): Promise<MoteDialoguePage> => ({ main: { target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null, documentRevision: 'original-file', roleRevision:moteMainRoleRevision(defaults,'original-file'), current: reference, issue: null }, links: [], incarnation: 'original-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }))
  vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(new Error('Original conversation source unavailable'))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation(async input => { const closed = new AbortController(); return { ...input, sourceHostId: input.hostId, scope: { sources: [] }, coverage: [], closed: closed.signal, dispose() { closed.abort() } } })
  return { read, topics, defaults, ensure: vi.spyOn(api.moteDialogue, 'ensureRecovery'), inspect: vi.spyOn(api.moteDialogue, 'inspectRecovery'), open: vi.spyOn(api.spatial, 'openAgent'), send: vi.spyOn(useAppStore.getState(), 'send') }
}
async function mounted(node:ReactNode = <App />) { const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container); closes.push(async () => { await act(async () => root.unmount()); container.remove() }); await act(async () => root.render(node)); return container }
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)

it('the current Main uses one common service state and one manual action while original capabilities remain in details',async()=>{
  const calls=setup(),container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service] .service-window')).not.toBeNull())
  const service=container.querySelector('[data-mote-main-service]')!
  expect(service.textContent).toContain('尚未配置自动接续')
  expect([...service.querySelectorAll('button')].map(e=>e.textContent)).toEqual(['继续新对话'])
  expect(service.querySelector('.primary-button')).toBeNull()
  const reader=container.querySelector('.activity-feed[data-mote-conversation="true"]')!
  const details=reader.querySelector<HTMLDetailsElement>('.mote-conversation__reading-tools')!
  expect(details.open).toBe(false)
  expect(reader.querySelector('[data-original-session-actions]')).toBeNull()
  expect(button(reader,'Take over')?.closest('details')).toBe(details)
  expect(reader.querySelector('.activity-feed__read-notice')?.closest('details')).toBe(details)
  expect(reader.querySelector('.activity-feed__reading-service')?.closest('details')).toBe(details)
  expect(container.querySelector('[aria-label="Message Agent"]')?.getAttribute('data-placeholder')??container.querySelector('[aria-label="Message Agent"]')?.textContent).not.toContain('Send to restore')
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled()
})

it('saved automatic policy explains the next new question without inventing a switch or starting work',async()=>{
  const calls=setup('automatic'),container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')?.textContent).toContain('已开启自动接续'))
  const service=container.querySelector('[data-mote-main-service]')!
  expect(service.textContent).toContain('新问题由保存的策略决定是否切换')
  expect(service.textContent).not.toContain('正在')
  expect(service.querySelectorAll('button').length).toBe(0)
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled()
})

it('keep-current offers one explicit new conversation and preserves the original draft and unknown query',async()=>{
  const calls=setup('keep-current')
  const key=moteEntryDraftKey({workspace:scratchWorkspace,topic:moteTopics[0]!,rootPath:scratchTopicLogicalPath(scratchWorkspace,moteTopics[0]!)!})
  useLauncherState.getState().setDraft(key,'prompt','Original unsent draft')
  const old={operationId:'original-query',text:'Old question waiting for the original Agent',status:'deferred',runId:defaultAgent.control.run.runId,promptCondition:null,inputIntakeStarted:true,error:'Original reply unknown'}
  useAppStore.setState({agentSteerQueues:{[defaultAgent.id]:[old as any]}})
  const container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')?.textContent).toContain('已设为保留当前对话'))
  await act(async()=>button(container.querySelector('[data-mote-main-service]')!,'继续新对话')!.click())
  await vi.waitFor(()=>expect(container.textContent).toContain('旧对话和未确认的消息留在原处'))
  expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Original unsent draft')
  expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]).toEqual([old])
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})

it('unconfirmed settings offer the original settings read rather than claiming automatic is enabled',async()=>{
  const calls=setup('unconfirmed'),container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')?.textContent).toContain('接续设置尚未确认'))
  const service=container.querySelector('[data-mote-main-service]')!
  expect(service.textContent).not.toContain('已开启')
  await act(async()=>button(service,'核对接续设置')!.click())
  await vi.waitFor(()=>expect(document.querySelector('.mote-quick-mode-dialog')).not.toBeNull())
  expect(calls.open).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})

it('unknown original recovery has its own read action and never claims creation is pending',async()=>{
  const calls=setup()
  useAppStore.setState(state=>({sessions:state.sessions.map(item=>item.id===defaultAgent.id?{...item,continuity:{...item.continuity!,kind:'pending',reason:'operation-unconfirmed',evidence:{kind:'run-unknown',observedAt:1,message:'Original recovery reply unknown'}},status:{...item.status,continuity:undefined,continuityReason:undefined}}:item)} as any))
  const refresh=vi.spyOn(api.sessions,'refresh').mockResolvedValue(useAppStore.getState().sessions.find(item=>item.id===defaultAgent.id)!)
  const container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')?.textContent).toContain('主对话恢复尚待确认'))
  const service=container.querySelector('[data-mote-main-service]')!
  expect(service.textContent).not.toContain('开始请求')
  await act(async()=>button(service,'核对恢复进度')!.click())
  await vi.waitFor(()=>expect(refresh).toHaveBeenCalled())
  expect(refresh.mock.calls.every(([control])=>control.agentSessionId===defaultAgent.id&&control.run.runId===defaultAgent.control.run.runId)).toBe(true)
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled()
})

it.each(['healthy','later-run'] as const)('the %s original keeps independent reading failures and capabilities without Main failure chrome',async(kind)=>{
  const calls=setup()
  useAppStore.setState(state=>({sessions:state.sessions.map(item=>item.id===defaultAgent.id&&item.kind==='agent'?{...item,...(kind==='healthy'?{processState:'running' as const}:{control:{...item.control,run:{runId:'later-run'}}})}:item)}))
  const container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('.activity-feed__reading-service')).not.toBeNull())
  expect(container.querySelector('[data-mote-main-service]')).toBeNull()
  expect(container.querySelector('.activity-feed__reading-service')?.closest('details')).toBeNull()
  if(kind==='later-run')expect(container.querySelector('[data-original-session-actions]')).not.toBeNull()
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})

it('an unknown original creation opens its existing progress and never creates a second Main',async()=>{
  const calls=setup()
  const scope={workspace:scratchWorkspace,topic:moteTopics[0]!,rootPath:scratchTopicLogicalPath(scratchWorkspace,moteTopics[0]!)!}
  await expect(retainMoteMainCreationReference({target:moteConnectionTarget(scope,useAppStore.getState().spaceZoneBindings),operationId:'original-start'},null)).rejects.toThrow('Saved workbench storage is unavailable')
  const original=structuredClone(useAppStore.getState().moteMainCreationReferences)
  const container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')?.textContent).toContain('开始请求尚待确认'))
  await act(async()=>button(container.querySelector('[data-mote-main-service]')!,'查看开始进度')!.click())
  await vi.waitFor(()=>expect(container.querySelector('[data-main-original-request]')?.textContent).toContain('核对原开始请求'))
  expect(useAppStore.getState().moteMainCreationReferences).toEqual(original)
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled()
})

it.each(['role','document','position'] as const)('a saved automatic policy with a different %s does not describe this Main as automatic',async(kind)=>{
  const calls=setup('automatic'),topic=calls.topics[0]!
  topic.quickMode={status:'saved',version:kind==='document'?'different-document':'original-file',defaults:{...calls.defaults,
    ...(kind==='role'?{conversationRevision:'different-role'}:{}),...(kind==='position'?{conversation:{...reference,regionId:'different-region'}}:{})}}
  const container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')?.textContent).toContain('接续设置尚未确认'))
  expect(container.querySelector('[data-mote-main-service]')?.textContent).not.toContain('已开启自动接续')
  expect(button(container.querySelector('[data-mote-main-service]')!,'核对接续设置')).toBeDefined()
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})

it('the original typed unavailable decision reaches the full App new-question surface without mislabelling it as idle',async()=>{
  const calls=setup('automatic'),scope={workspace:scratchWorkspace,topic:calls.topics[0]!,rootPath:scratchTopicLogicalPath(scratchWorkspace,moteTopics[0]!)!}
  const target=moteConnectionTarget(scope,useAppStore.getState().spaceZoneBindings),operationId='separately-new-query'
  const old={operationId:'original-unknown-query',text:'Old question remains here',status:'deferred',runId:defaultAgent.control.run.runId,promptCondition:null,inputIntakeStarted:true}
  const mainRollover={target,reference,expectedRoleRevision:moteMainRoleRevision(calls.defaults,'original-file'),queryInputKey:{kind:'prompt',agentSessionId:defaultAgent.id,expectedRun:defaultAgent.control.run,submissionId:operationId},
    policyRevision:'original-file',policy:{kind:'continuity-unavailable',idleMs:60000},continuity:{operationId:'original-recovery',previousRun:defaultAgent.control.run,reason:'native-handle-unavailable',evidence:{kind:'run-ended',state:'exited',observedAt:1}},
    evaluatedAt:2,queryOperationId:operationId,creationOperationId:'new-query-creation'}
  const container=await mounted()
  await act(async()=>useAppStore.setState({agentSteerQueues:{[defaultAgent.id]:[old,{...old,operationId,text:'A separately new question',mainRollover}] as any}}))
  await vi.waitFor(()=>expect(container.textContent).toContain('保存的接续策略为这条新问题选择新对话'))
  expect(container.textContent).not.toContain('空闲策略承接原输入')
  expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]?.[0]).toEqual(old)
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})

it('changing only service presentation retains the actual Composer DOM and original Mote draft',async()=>{
  const calls=setup('automatic'),key=moteEntryDraftKey({workspace:scratchWorkspace,topic:moteTopics[0]!,rootPath:scratchTopicLogicalPath(scratchWorkspace,moteTopics[0]!)!})
  useLauncherState.getState().setDraft(key,'prompt','Original editable Mote draft')
  const container=await mounted()
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')).not.toBeNull())
  const original=container.querySelector('[aria-label="Message Agent"]')!
  await vi.waitFor(()=>expect(original.textContent).toContain('Original editable Mote draft'))
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(item=>item.id===defaultAgent.id?{...item,processState:'running' as const}:item)})))
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')).toBeNull())
  expect(container.querySelector('[aria-label="Message Agent"]')).toBe(original)
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(item=>item.id===defaultAgent.id?{...item,processState:'exited' as const}:item)})))
  await vi.waitFor(()=>expect(container.querySelector('[data-mote-main-service]')).not.toBeNull())
  expect(container.querySelector('[aria-label="Message Agent"]')).toBe(original)
  expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Original editable Mote draft')
  expect(calls.send).not.toHaveBeenCalled();expect(calls.open).not.toHaveBeenCalled()
})
