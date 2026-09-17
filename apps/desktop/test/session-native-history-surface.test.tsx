// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl, AgentSessionRecoveryCandidate, SessionSnapshot } from '../src/shared/contracts'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const fixture = vi.hoisted(() => ({
  historyPage: vi.fn(), write: vi.fn(), clipboard: vi.fn(), terminalMount: vi.fn(), terminalUnmount: vi.fn(),
  resizeObservers: [] as Array<() => void>,
  state: { sessions: [] as SessionSnapshot[], config: { appearance: { terminalTheme: 'graphite' }, executors: {}, workspaces: [] }, pendingAgentLaunches: {}, recoveryCandidates: [] as AgentSessionRecoveryCandidate[],
    timelines: {}, agentNames: {}, viewModes: {}, regionCaretFocus: null,
    clearRegionCaretFocus: vi.fn(), focusRegion: vi.fn(), appendAgentComposerDraft: vi.fn(), refreshSession: vi.fn(),
    recoverSession: vi.fn(), respondInteraction: vi.fn(), openFile: vi.fn(), reportError: vi.fn(), openHttpLink: vi.fn() }
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: {
  sessions: { historyPage: fixture.historyPage, write: fixture.write },
  ui: { writeClipboardText: fixture.clipboard }
} }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (select: (state: typeof fixture.state) => unknown) => select(fixture.state), { getState: () => fixture.state }
) }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { fixture.terminalMount(); return () => fixture.terminalUnmount() }, [])
  return <div>Retained terminal surface</div>
} }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original Agent composer" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div>Captured Activity</div> }))

const control: AgentSessionControl = {kind:'agent',hostId:'local',agentSessionId:'agent-history',run:{runId:'run-history'}}
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: control.agentSessionId, hostId:'local',workspacePath:'/synthetic',label:'Reader',createdAt:1,updatedAt:1,
  processState:'running',status:{state:'running',source:'run-process',observedAt:1},latestOutputBytes:0,
  kind:'agent',providerId:'codex',executorId:'codex',control,
  capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'}
}
function page(id: string, nextCursor: string | null, overrides: Partial<AgentSessionHistoryPage> = {}): AgentSessionHistoryPage {
  return {agentSessionId:control.agentSessionId,source:{providerId:'codex',nativeSessionId:'native-main'},
    items:[{id,kind:'assistant-message',contentParts:[{kind:'text',text:`body ${id}`}]}],nextCursor,...overrides}
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.resizeObservers.length = 0
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { fixture.resizeObservers.push(callback) } observe() {} disconnect() {} })
  fixture.state.sessions = [session]
  fixture.state.recoveryCandidates = []
  fixture.historyPage.mockResolvedValue(page('latest','older-1'))
  fixture.clipboard.mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root=createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function mountReader(nextControl = control) {
  await act(async () => root.render(<SessionHistoryView control={nextControl} label="Reader" onClose={() => {}} visible themeId="graphite" fontSize={12} workspaceRoot="/synthetic" openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
}
function button(text: string) {
  const found=Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent?.trim()===text.trim())
  expect(found, `reachable ${text} action`).toBeDefined(); return found!
}
async function wheelUp() {
  const viewport=container.querySelector<HTMLDivElement>('[aria-label="Native conversation records"]')!
  expect(viewport).not.toBeNull(); viewport.scrollTop=0
  await act(async () => viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true})))
}

it('opens native history in the actual SessionPane while keeping the original Terminal and composer mounted', async () => {
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}} />))
  await act(async () => button('Conversation history').click())
  expect(fixture.historyPage).toHaveBeenCalledWith(control,undefined)
  expect(container.querySelector('[aria-label="Conversation history"]')).not.toBeNull()
  expect(container.textContent).toContain('body latest')
  expect(container.querySelector('[aria-label="Original Agent composer"]')).not.toBeNull()
  expect(fixture.terminalMount).toHaveBeenCalledTimes(1)
  expect(fixture.terminalUnmount).not.toHaveBeenCalled()
  await act(async () => button(' Terminal').click())
  expect(container.querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(fixture.terminalUnmount).not.toHaveBeenCalled()
  expect(fixture.write).not.toHaveBeenCalled()
})

it('keeps the native history entry reachable when the Agent Run is unavailable', async () => {
  fixture.state.sessions = [{ ...session, processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: 1 } }]
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}} />))
  expect(container.textContent).toContain('Ready to restore')
  expect(fixture.historyPage).not.toHaveBeenCalled()
  await act(async () => button('Conversation history').click())
  expect(fixture.historyPage).toHaveBeenCalledExactlyOnceWith(control, undefined)
  expect(container.textContent).toContain('body latest')
  expect(fixture.state.recoverSession).not.toHaveBeenCalled()
  expect(fixture.write).not.toHaveBeenCalled()
  expect(fixture.terminalMount).not.toHaveBeenCalled()
  await act(async () => button('Resume').click())
  expect(fixture.state.recoverSession).toHaveBeenCalledExactlyOnceWith(session.id)
  await act(async () => button('Session').click())
  expect(button('Conversation history')).toBeDefined()
  expect(fixture.terminalMount).not.toHaveBeenCalled()
  await act(async () => button('Resume').click())
  expect(fixture.state.recoverSession.mock.calls).toEqual([[session.id], [session.id]])
})

it('keeps a missing Run readable with a direct restore action when the independent history read fails', async () => {
  fixture.state.sessions = [{ ...session, processState: 'interrupted', status: { state: 'disconnected', source: 'run-process', observedAt: 1, detail: 'Idle time is unknown.' } }]
  fixture.state.recoveryCandidates = [{ agentSessionId: session.id, hostId: 'local', workspacePath: session.workspacePath,
    providerId: 'codex', executorId: 'codex', capabilities: session.capabilities,
    label: 'Pending', createdAt: 1, updatedAt: 1, run: control.run }]
  fixture.historyPage.mockRejectedValue(new Error('Native reader unavailable'))
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}} />))
  expect(container.textContent).toContain('Ready to restore')
  expect(fixture.historyPage).not.toHaveBeenCalled()
  await act(async () => button('Conversation history').click())
  expect(container.textContent).toContain('Idle time is unknown')
  expect(container.textContent).toContain('History read failed: Native reader unavailable')
  expect(button('Resume')).toBeDefined()
  expect(container.querySelector('[aria-label="Original Agent composer"]')).not.toBeNull()
  expect(fixture.terminalMount).not.toHaveBeenCalled()
  expect(fixture.state.recoverSession).not.toHaveBeenCalled()
  expect(fixture.write).not.toHaveBeenCalled()
})

it('does not start independent history reads for a hidden pending view', async () => {
  fixture.state.sessions = [{ ...session, processState: 'exited' }]
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={false} linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}} />))
  expect(fixture.historyPage).not.toHaveBeenCalled()
  expect(fixture.terminalMount).not.toHaveBeenCalled()
  expect(fixture.state.recoverSession).not.toHaveBeenCalled()
})

it('re-reads a changed canonical Run from the pending history notice without resuming again', async () => {
  fixture.state.sessions = [{ ...session, processState: 'interrupted', status: { state: 'error', source: 'run-process', observedAt: 1,
    continuity: 'conflict', continuityConflict: 'session-run-changed' } }]
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}} />))
  await act(async () => button('Re-read this Agent').click())
  expect(fixture.state.refreshSession).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(fixture.state.recoverSession).not.toHaveBeenCalled()
  expect(fixture.terminalMount).not.toHaveBeenCalled()
})

it('real upward wheel pages once while pending, keeps ordered resources, and does not infer end from an empty page', async () => {
  fixture.historyPage.mockResolvedValueOnce(page('latest','opaque-1',{items:[{id:'mixed',kind:'user-message',contentParts:[
    {kind:'text',text:'before  \n'}, {kind:'resource',resourceType:'image',reference:'/synthetic/image.png',label:'Screenshot'}, {kind:'text',text:'after'}
  ]}]}))
  await mountReader()
  const article=container.querySelector('article')!
  expect(article.textContent).toContain('before  \nScreenshot/synthetic/image.png')
  expect(article.textContent).toContain('after')
  expect(article.querySelector('time')).toBeNull()
  let resolve!: (value: AgentSessionHistoryPage) => void
  fixture.historyPage.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => { resolve=done }))
  await wheelUp(); await wheelUp(); await wheelUp()
  expect(fixture.historyPage.mock.calls).toEqual([[control,undefined],[control,{cursor:'opaque-1'}]])
  await act(async () => resolve(page('empty','opaque-2',{items:[]})))
  expect(container.textContent).not.toContain('Beginning of the available native history')
  expect(button('Load earlier records')).toBeDefined()
  fixture.historyPage.mockResolvedValueOnce(page('oldest',null))
  await wheelUp()
  expect(fixture.historyPage).toHaveBeenLastCalledWith(control,{cursor:'opaque-2'})
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-history-item-id]'),(row) => row.dataset.historyItemId)).toEqual(['oldest','mixed'])
  expect(container.textContent).toContain('Beginning of the available native history')
})

it('uses the shared message owner for ordered native parts, exact copy and host links without invented metadata', async () => {
  const parts = [
    { kind: 'text' as const, text: 'before' },
    { kind: 'resource' as const, resourceType: 'image' as const, reference: 'opaque-image-reference', label: 'Screenshot' },
    { kind: 'text' as const, text: '[guide](src/guide.ts:4) and [web](https://docs.example.test/read)' },
    { kind: 'resource' as const, resourceType: 'audio' as const, reference: '/synthetic/audio.wav' }
  ]
  fixture.historyPage.mockResolvedValue(page('unused', null, { items: [
    { id: 'native-user', kind: 'user-message', contentParts: parts, completedAt: 500 },
    { id: 'native-assistant', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'known zero clock' }], startedAt: 0 },
    { id: 'native-activity', kind: 'activity', title: 'Tool observation', contentParts: [{ kind: 'text', text: 'native tool facts' }] }
  ] }))
  const openWorkspaceFile = vi.fn(), openHttpLink = vi.fn()
  await act(async () => root.render(<SessionHistoryView control={control} label="Reader" visible themeId="graphite" fontSize={17}
    workspaceRoot="/synthetic" openWorkspaceFile={openWorkspaceFile} openHttpLink={openHttpLink} />))
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-history-item-id]'))
  expect(rows.map(row => row.dataset.historyItemId)).toEqual(['native-user', 'native-assistant', 'native-activity'])
  expect(rows.map(row => row.querySelector('.log-turn')?.getAttribute('data-speaker-role'))).toEqual(['human', 'agent', null])
  expect(rows.map(row => row.querySelector('.log-turn__who')?.textContent)).toEqual(['You', 'Reader', 'Tool observation'])
  expect(rows.map(row => row.querySelector('.log-turn')?.getAttribute('data-status'))).toEqual([null, null, null])
  expect(rows.map(row => row.querySelector('.log-turn__time')?.textContent ?? null)).toEqual([null, new Date(0).toTimeString().slice(0, 8), null])
  const body = rows[0]!.querySelector('.log-turn__body')!
  expect(Array.from(body.children, node => node.matches('.log-turn__resource')
    ? ['resource', node.querySelector('span')?.textContent, node.querySelector('code')?.textContent]
    : ['text', node.textContent])).toEqual([
      ['text', 'before'], ['resource', 'Screenshot', 'opaque-image-reference'],
      ['text', 'guide and web'], ['resource', 'audio resource', '/synthetic/audio.wav']
    ])
  expect(Array.from(body.querySelectorAll('.log-turn__resource code'), node => node.textContent)).toEqual(['opaque-image-reference', '/synthetic/audio.wav'])
  expect(body.querySelector('img')).toBeNull()
  expect(container.querySelector('.log-turn__annotation')).toBeNull()
  const file = body.querySelector<HTMLButtonElement>('.md-link--file')!
  expect(file).not.toBeNull()
  await act(async () => file.click())
  expect(openWorkspaceFile).toHaveBeenCalledExactlyOnceWith('src/guide.ts', { line: 4 })
  const web = Array.from(body.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === 'web')!
  expect(web).toBeDefined()
  await act(async () => web.click())
  expect(openHttpLink).toHaveBeenCalledExactlyOnceWith('https://docs.example.test/read', expect.objectContaining({ metaKey: false, ctrlKey: false }))
  const copy = rows[0]!.querySelector<HTMLButtonElement>('[title="Copy message"]')!
  expect(copy).not.toBeNull()
  vi.useFakeTimers()
  await act(async () => copy.click())
  expect(fixture.clipboard).toHaveBeenCalledExactlyOnceWith('before\nScreenshot\nopaque-image-reference\n[guide](src/guide.ts:4) and [web](https://docs.example.test/read)\n/synthetic/audio.wav')
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
  expect(fixture.historyPage).toHaveBeenCalledExactlyOnceWith(control, undefined)
  expect(fixture.write).not.toHaveBeenCalled()
  expect(fixture.state.recoverSession).not.toHaveBeenCalled()
  expect(fixture.terminalMount).not.toHaveBeenCalled()
})

it('retains a stable visible item pixel anchor through prepend and later content reflow', async () => {
  await mountReader()
  const viewport=container.querySelector<HTMLDivElement>('[aria-label="Native conversation records"]')!
  let oldRowTop=20
  let grew=0
  const bounds=(top:number,bottom:number) => ({top,bottom,left:0,right:500,width:500,height:bottom-top,x:0,y:top,toJSON(){}})
  vi.spyOn(viewport,'getBoundingClientRect').mockImplementation(() => bounds(10,210))
  const original=container.querySelector<HTMLElement>('[data-history-item-id="latest"]')!
  vi.spyOn(original,'getBoundingClientRect').mockImplementation(() => bounds(oldRowTop+grew-viewport.scrollTop,oldRowTop+grew-viewport.scrollTop+40))
  let resolve!: (value:AgentSessionHistoryPage) => void
  fixture.historyPage.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => {resolve=done}))
  await wheelUp()
  grew=150
  // The response is pending: the current visible item is captured before React inserts the older row.
  grew=0
  await act(async () => {
    resolve(page('older',null))
    let captured=false
    grew=150
    vi.mocked(original.getBoundingClientRect).mockImplementation(() => {
      const growth=captured ? grew : 0
      captured=true
      return bounds(oldRowTop+growth-viewport.scrollTop,oldRowTop+growth-viewport.scrollTop+40)
    })
  })
  expect(viewport.scrollTop).toBe(150)
  grew=200
  await act(async () => fixture.resizeObservers[0]!())
  expect(viewport.scrollTop).toBe(200)
  expect(original.getBoundingClientRect().top-viewport.getBoundingClientRect().top).toBe(10)
})

it('bounds the nearby window to three pages and re-reads canonical latest on its explicit action', async () => {
  await mountReader()
  fixture.historyPage.mockResolvedValueOnce(page('older-1','cursor-2'))
  await wheelUp()
  fixture.historyPage.mockResolvedValueOnce(page('older-2','cursor-3'))
  await wheelUp()
  fixture.historyPage.mockResolvedValueOnce(page('older-3','cursor-4'))
  await wheelUp()
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-history-item-id]'),(row) => row.dataset.historyItemId)).toEqual(['older-3','older-2','older-1'])
  expect(container.textContent).toContain('Newer records are outside this three-page reading window')
  fixture.historyPage.mockResolvedValueOnce(page('fresh-latest','fresh-cursor'))
  await act(async () => button('Return to latest').click())
  expect(fixture.historyPage).toHaveBeenLastCalledWith(control,undefined)
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-history-item-id]'),(row) => row.dataset.historyItemId)).toEqual(['fresh-latest'])
})

it('preserves the current page on failed reads or changed native source and exposes retry', async () => {
  await mountReader()
  fixture.historyPage.mockRejectedValueOnce(new Error('official endpoint unavailable'))
  await wheelUp()
  expect(container.textContent).toContain('official endpoint unavailable')
  expect(container.textContent).toContain('body latest')
  fixture.historyPage.mockResolvedValueOnce(page('foreign',null,{source:{providerId:'codex',nativeSessionId:'native-other'}}))
  await act(async () => button(' Retry').click())
  expect(container.textContent).toContain('native history source changed')
  expect(container.textContent).not.toContain('body foreign')
  expect(container.textContent).toContain('body latest')
})

it('retry repeats a failed Latest read rather than changing to the older cursor', async () => {
  await mountReader()
  fixture.historyPage.mockRejectedValueOnce(new Error('latest temporarily unavailable'))
  await act(async () => button('Latest').click())
  expect(container.textContent).toContain('body latest')
  fixture.historyPage.mockResolvedValueOnce(page('refreshed', 'refreshed-cursor'))
  await act(async () => button('Retry').click())
  expect(fixture.historyPage.mock.calls).toEqual([[control, undefined], [control, undefined], [control, undefined]])
  expect(container.textContent).toContain('body refreshed')
})

it('does not duplicate an overlapping canonical item while retaining the complete activity body', async () => {
  await mountReader()
  fixture.historyPage.mockResolvedValueOnce(page('older', null, { items: [
    { id: 'older', kind: 'activity', title: 'Unrecognized native activity', contentParts: [{ kind: 'text', text: 'original activity  \n' }] },
    { id: 'latest', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'body latest' }] }
  ] }))
  await wheelUp()
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-history-item-id]'), row => row.dataset.historyItemId)).toEqual(['older', 'latest'])
  expect(container.textContent).toContain('Unrecognized native activity')
  expect(container.querySelector('[data-history-item-id="older"]')?.textContent).toContain('original activity  \n')
})

it('discards a late page for another Session without leaking its content or cursor', async () => {
  let resolve!: (value:AgentSessionHistoryPage) => void
  fixture.historyPage.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => {resolve=done}))
  await mountReader()
  const nextControl={...control,agentSessionId:'new-session',run:{runId:'new-run'}}
  fixture.historyPage.mockResolvedValueOnce(page('new-record','new-cursor',{agentSessionId:'new-session'}))
  await mountReader(nextControl)
  await act(async () => resolve(page('late-old-record','old-cursor')))
  expect(container.textContent).toContain('body new-record')
  expect(container.textContent).not.toContain('late-old-record')
  fixture.historyPage.mockResolvedValueOnce(page('new-older',null,{agentSessionId:'new-session'}))
  await wheelUp()
  expect(fixture.historyPage).toHaveBeenLastCalledWith(nextControl,{cursor:'new-cursor'})
})
