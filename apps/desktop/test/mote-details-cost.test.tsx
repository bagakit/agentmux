// @vitest-environment happy-dom
import { chooseField } from './helpers/selection-field'
import { act, Profiler, StrictMode } from 'react'
import { createRoot as createDomRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop, FileReadParams, FileReadResult } from '@agentmux/core'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteTopics, defaultAgent, neighborAgent, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { GoalContinuationControl } from '../src/renderer/src/components/GoalContinuationControl'
import { MoteDetailsPanel } from '../src/renderer/src/components/MoteDetailsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useWorkspaceFileTree } from '../src/renderer/src/components/file-tree/useWorkspaceFileTree'
import { useScratchTopics } from '../src/renderer/src/hooks/useScratchTopics'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { useGitStatus } from '../src/renderer/src/hooks/useGitStatus'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import * as behavior from '../src/renderer/src/lib/mote-behavior'

const markdown = vi.hoisted(() => ({ renders: 0 }))
vi.mock('@agentmux/client-ui/components/AgentMarkdown', async () => {
  const original = await vi.importActual<typeof import('@agentmux/client-ui/components/AgentMarkdown')>('@agentmux/client-ui/components/AgentMarkdown')
  return { ...original, AgentMarkdown: (props: Parameters<typeof original.AgentMarkdown>[0]) => { markdown.renders++; return <original.AgentMarkdown {...props} /> } }
})
const original = useAppStore.getState(), rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const scope = { workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!, rootPath }
const soul = '# Original fixture SOUL\n' + Array.from({ length: 300 }, (_, index) => `- Saved fact ${index}`).join('\n')
const notePath = rootPath + '/idea.md'
const entry = { path: notePath, name: 'idea.md', isDirectory: false, isSymlink: false }
function material(params: FileReadParams, content: string): FileReadResult {
  return { resource: { ...params.expectedResource!, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + rootPath, path: rootPath + '/' + params.path }, result: { status: 'read', document: { path: rootPath + '/' + params.path, content, revision: 'sha256:' + 'c'.repeat(64) } } }
}
let root: Root, container: HTMLDivElement, renders: number
const openPath = vi.fn(async (_path: string) => {}), createNote = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedMoteWorkface(); useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: scratchWorkspace.id })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([entry])
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => material(params, params.path === 'SOUL.md' ? soul : params.path === 'BEHAVIOR.md' ? behavior.DEFAULT_MOTE_BEHAVIOR : '# Saved idea'))
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container); renders = 0; markdown.renders = 0
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(original, true); vi.restoreAllMocks() })
async function mount() {
  await act(async () => root.render(<Profiler id="mote-details" onRender={() => { renders++ }}><MoteDetailsPanel scope={scope} onOpenPath={openPath} onCreateNote={createNote} /></Profiler>))
  expect(container.querySelector('.mote-details__status')?.textContent).toBe('working')
  expect(container.querySelector('.mote-details__soul')).not.toBeNull()
  expect(api.files.readPublic).toHaveBeenCalled()
  expect(markdown.renders).toBe(0) // A closed native disclosure must not mount the real Markdown consumer.
  renders = 0; markdown.renders = 0
}
it('nonempty Details ignores selected Session bookkeeping and never parses closed SOUL Markdown', async () => {
  await mount()
  const parse = vi.spyOn(behavior, 'parseMoteBehaviorDocument')
  for (let index = 0; index < 20; index++) await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, updatedAt: session.updatedAt + 1, latestOutputBytes: index + 1 } : session) })))
  console.info('T003-fixed-cost', JSON.stringify({ events: 20, commits: renders, behaviorParses: parse.mock.calls.length, closedMarkdownRenders: markdown.renders }))
  expect(renders).toBe(0); expect(parse).not.toHaveBeenCalled(); expect(markdown.renders).toBe(0)
})

it('Profile keeps the saved topic context on demand and opens its original file without replacing SOUL', async () => {
  const savedScope = { ...scope, topic: { ...scope.topic, summary: 'My original saved project context.' } }
  await act(async () => root.render(<MoteDetailsPanel scope={savedScope} onOpenPath={openPath} onCreateNote={createNote} />))
  expect(container.textContent).not.toContain(savedScope.topic.summary)
  expect(markdown.renders).toBe(0)
  const details = container.querySelector<HTMLDetailsElement>('.mote-details__soul')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(details.textContent).toContain(savedScope.topic.summary)
  expect(details.textContent).toContain('topic.md · saved context')
  expect(details.textContent).toContain('SOUL.md · self instructions')
  expect(details.textContent).toContain('Saved fact 299')
  await click('Open original context')
  expect(openPath).toHaveBeenLastCalledWith(rootPath + '/topic.md')
  await click('Open original SOUL')
  expect(openPath).toHaveBeenLastCalledWith(rootPath + '/SOUL.md')
})

it('confirmed empty Profile actions use the original Behavior dialog and Ideas tab', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([])
  await mount()
  await click('Choose how we work together.')
  expect(document.querySelector('.mote-behavior-dialog')).not.toBeNull()
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close behavior settings"]')!
  await act(async () => close.click())
  await click('View ideas and saved materials')
  expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Mote ideas')
})

it('hidden Surface Files consumer defers automatic reads and changed revisions', async () => {
  useAppStore.setState({ workspaceTool: 'files-branches', explorerCollapsed: { [scratchWorkspace.id]: false } })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('file-tree') ? 240 : 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('file-tree') ? 300 : 0 })
  await act(async () => root.render(<SurfaceToolDock workspace={scratchWorkspace} visible={false} />))
  const reads = vi.mocked(api.files.readDirectory).mock.calls.length
  for (let index = 1; index <= 3; index++) await act(async () => useAppStore.setState({ workspaceFileRevisions: { [scratchWorkspace.id]: index } }))
  console.info('T003-fixed-hidden-files', JSON.stringify({ initialDirectoryReads: reads, hiddenRevisionChanges: 3, extraDirectoryReads: vi.mocked(api.files.readDirectory).mock.calls.length - reads }))
  expect(reads).toBe(0)
  expect(vi.mocked(api.files.readDirectory).mock.calls.length - reads).toBe(0)
  await act(async () => root.render(<SurfaceToolDock workspace={scratchWorkspace} visible />))
  expect(vi.mocked(api.files.readDirectory).mock.calls.filter(([workspace, path]) => workspace === scratchWorkspace.id && path === rootPath)).toHaveLength(2) // Original FileExplorer and Mote notes each own one directory projection.
  expect(container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0)
})

async function renderDetails(active = true) {
  await act(async () => root.render(<Profiler id="mote-details" onRender={() => { renders++ }}><MoteDetailsPanel scope={scope} active={active} onOpenPath={openPath} onCreateNote={createNote} /></Profiler>))
}
async function revision(value: number) { await act(async () => useAppStore.setState({ workspaceFileRevisions: { [scratchWorkspace.id]: value } })) }
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label || element.querySelector('strong')?.textContent === label || element.querySelector('span')?.firstChild?.textContent === label)
  expect(button, 'Original button ' + label).toBeTruthy()
  await act(async () => button!.click())
}
async function input(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }

it('actual status/source updates remain visible without reparsing the saved behavior', async () => {
  await mount(); const parse = vi.spyOn(behavior, 'parseMoteBehaviorDocument')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, status: { state: 'waiting', source: 'user', observedAt: 99 } } : session) })))
  expect(container.querySelector('.mote-details__status')?.textContent).toBe('waiting')
  expect(container.querySelector('.mote-details__status .status')?.getAttribute('title')).toBe('waiting · user')
  expect(parse).not.toHaveBeenCalled(); expect(markdown.renders).toBe(0)
})

it('Original SOUL Markdown mounts on real disclosure, refreshes actual content, and retains its disclosure across hide', async () => {
  await mount(); expect(container.querySelector('.mote-details__soul .agent-markdown')).toBeNull()
  const details = container.querySelector<HTMLDetailsElement>('.mote-details__soul')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(markdown.renders).toBeGreaterThan(0); expect(details.textContent).toContain('Saved fact 299')
  await renderDetails(false); const before = markdown.renders
  vi.mocked(api.files.readPublic).mockImplementation(async params => material(params, '# Latest saved SOUL'))
  await revision(3); expect(markdown.renders).toBe(before)
  await renderDetails(); expect(details.open).toBe(true); expect(details.textContent).toContain('Latest saved SOUL')
  await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')) })
  const closed = markdown.renders
  await revision(4); expect(markdown.renders).toBe(closed)
})

it('hidden Profile retains original chooser, question, expanded Goal and minutes without rereading/restarting on reveal', async () => {
  const goal: DemandRecord = { id: 'same-goal', title: 'Same original Goal', description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null, sessionIds: [defaultAgent.id, neighborAgent.id], createdAt: 1, updatedAt: 2, source: 'session' }
  useAppStore.setState({ demands: { [goal.id]: goal } })
  await mount(); await click('Choose or create a goal'); await click('Same original Goal')
  const chooser = container.querySelector<HTMLElement>('[aria-label="Goal to associate with this Mote"]')!
  const minutes = container.querySelector<HTMLInputElement>('[aria-label="Goal continuation minutes"]')!
  const question = container.querySelector<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')!
  expect(chooser).toBeTruthy(); expect(minutes).toBeTruthy(); expect(question).toBeTruthy()
  await chooseField(chooser, goal.id); await input(minutes, '47'); await input(question, 'Keep my current question')
  const reads = vi.mocked(api.demands.list).mock.calls.length, inspections = vi.mocked(api.continuousProgress.goals).mock.calls.length
  await renderDetails(false); renders = 0
  const parse = vi.spyOn(behavior, 'parseMoteBehaviorDocument'), files = vi.mocked(api.files.readPublic), before = files.mock.calls.length
  for (let value = 1; value <= 5; value++) {
    await revision(value)
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, label: 'Hidden current name ' + value, updatedAt: value } : session) })))
  }
  expect(renders).toBe(0); expect(parse).not.toHaveBeenCalled(); expect(files.mock.calls.length).toBe(before)
  await renderDetails()
  expect(container.querySelector('[aria-label="Goal continuation minutes"]')).toBe(minutes); expect(minutes.value).toBe('47')
  expect(container.querySelector('[aria-label="Goal to associate with this Mote"]')).toBe(chooser); expect(chooser.dataset.value).toBe(goal.id)
  expect(question.value).toBe('Keep my current question')
  await chooseField(container.querySelector<HTMLElement>('[aria-label="Mote discussion for the goal"]')!, defaultAgent.id)
  expect(container.querySelector('[aria-label="Mote discussion for the goal"]')?.textContent).toContain('Hidden current name 5')
  expect(vi.mocked(api.demands.list).mock.calls.length).toBe(reads); expect(vi.mocked(api.continuousProgress.goals).mock.calls.length).toBe(inspections)
  expect(files.mock.calls.length).toBe(before + 1)
  expect(vi.mocked(api.files.readDirectory).mock.calls.length).toBe(2)
})

it('same-scope pending SOUL and goal inspection finish normally through hide without duplicate delivery', async () => {
  const saved = deferred<FileReadResult>(), goals = deferred<Awaited<ReturnType<typeof api.demands.list>>>()
  let params!: FileReadParams
  vi.mocked(api.files.readPublic).mockImplementation(input => { if (input.path !== 'BEHAVIOR.md') return Promise.resolve(material(input, '# Pending original completed')); params = input; return saved.promise })
  vi.mocked(api.demands.list).mockReturnValue(goals.promise)
  await renderDetails(); expect(api.files.readPublic).toHaveBeenCalledTimes(1); expect(api.demands.list).toHaveBeenCalledTimes(1)
  await renderDetails(false); await renderDetails(); await renderDetails(false)
  expect(api.files.readPublic).toHaveBeenCalledTimes(1); expect(api.demands.list).toHaveBeenCalledTimes(1)
  await act(async () => { saved.resolve(material(params, behavior.DEFAULT_MOTE_BEHAVIOR)); goals.resolve([]) })
  await renderDetails()
  expect(api.files.readPublic).toHaveBeenCalledTimes(1); expect(api.demands.list).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain('Reading saved behavior')
  await act(async () => { const details = container.querySelector<HTMLDetailsElement>('.mote-details__soul')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(container.textContent).toContain('Pending original completed')
})

it('selected Ideas note pauses hidden revisions, preserves last confirmed content and retries actual failure', async () => {
  await mount(); await click('Ideas'); await click('idea')
  expect(container.textContent).toContain('Saved idea')
  await renderDetails(false); const before = vi.mocked(api.files.readPublic).mock.calls.length
  vi.mocked(api.files.readPublic).mockImplementation(async params => material(params, '# Latest same note'))
  await revision(2); expect(vi.mocked(api.files.readPublic).mock.calls.length).toBe(before)
  await renderDetails(); expect(container.textContent).toContain('Latest same note')
  expect(vi.mocked(api.files.readPublic).mock.calls.length).toBe(before + 1)
  vi.mocked(api.files.readPublic).mockRejectedValueOnce(new Error('Original note temporarily unavailable'))
  await revision(3)
  expect(container.textContent).toContain('Original note temporarily unavailable'); expect(container.textContent).toContain('Latest same note'); expect(container.textContent).toContain('Last confirmed saved content')
  await renderDetails(false); await renderDetails()
  expect(container.textContent).toContain('Original note temporarily unavailable')
  await click('Retry'); expect(container.textContent).not.toContain('Original note temporarily unavailable')
})

const noExpanded: ReadonlySet<string> = new Set()
let tree: ReturnType<typeof useWorkspaceFileTree>
function TreeReader({ active, path = rootPath }: { active: boolean; path?: string }) {
  tree = useWorkspaceFileTree(scratchWorkspace.id, noExpanded, path, active)
  return <div data-reader>{tree.rootError ?? tree.rootCache?.children.map(entry => entry.name).join(',') ?? 'Not loaded'}</div>
}
it('original tree keeps admitted same-scope flight/cache/errors, while explicit refresh remains valid when hidden', async () => {
  const pending = deferred<typeof entry[]>()
  vi.mocked(api.files.readDirectory).mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<TreeReader active />))
  await act(async () => root.render(<TreeReader active={false} />))
  await act(async () => root.render(<TreeReader active />))
  expect(api.files.readDirectory).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve([entry])); expect(container.textContent).toBe('idea.md')
  await act(async () => root.render(<TreeReader active={false} />))
  vi.mocked(api.files.readDirectory).mockRejectedValueOnce(new Error('Original directory unavailable'))
  await act(async () => { await tree.refreshTree() })
  expect(tree.rootCache?.children[0]?.name).toBe('idea.md'); expect(tree.rootError).toBe('Original directory unavailable')
  const reads = vi.mocked(api.files.readDirectory).mock.calls.length
  await act(async () => root.render(<TreeReader active />)); expect(api.files.readDirectory).toHaveBeenCalledTimes(reads)
  expect(container.textContent).toContain('Original directory unavailable')
  await act(async () => { await tree.refreshTree() }); expect(container.textContent).toBe('idea.md')
})

it('old directory flight cannot populate a new hidden original root, and reveal reads the new resource once', async () => {
  const pending = deferred<typeof entry[]>()
  vi.mocked(api.files.readDirectory).mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<TreeReader active />))
  await act(async () => root.render(<TreeReader active={false} path="another-original-root" />))
  await act(async () => pending.resolve([entry])); expect(container.textContent).toBe('Not loaded')
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ ...entry, path: 'another-original-root/new.md', name: 'new.md' }])
  await act(async () => root.render(<TreeReader active path="another-original-root" />))
  expect(container.textContent).toBe('new.md'); expect(api.files.readDirectory).toHaveBeenCalledTimes(2)
})

function ScratchReader({ active }: { active: boolean }) { const result = useScratchTopics(scratchWorkspace.id, active); return <div>{result.topics?.map(topic => topic.title).join(',') ?? result.error ?? 'Unknown'}</div> }
it('original Scratch discovery retains cached metadata, pauses hidden revision churn and resumes the same owner once', async () => {
  await act(async () => root.render(<ScratchReader active={false} />))
  expect(container.textContent).toContain('Mote'); expect(api.scratch.listTopics).not.toHaveBeenCalled()
  await revision(1); await revision(2); expect(api.scratch.listTopics).not.toHaveBeenCalled()
  await act(async () => root.render(<ScratchReader active />)); expect(api.scratch.listTopics).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<ScratchReader active={false} />)); await act(async () => root.render(<ScratchReader active />))
  expect(api.scratch.listTopics).toHaveBeenCalledTimes(1)
})

it('hidden FileExplorer defers real create request without marking it handled and keeps inline input across visibility', async () => {
  const handled = vi.fn(), request = { requestId: 71, parentPath: rootPath }
  await act(async () => root.render(<FileExplorer workspaceId={scratchWorkspace.id} rootPath={rootPath} active={false} createRequest={request} onCreateRequestHandled={handled} />))
  expect(handled).not.toHaveBeenCalled(); expect(api.files.readDirectory).not.toHaveBeenCalled()
  await act(async () => root.render(<FileExplorer workspaceId={scratchWorkspace.id} rootPath={rootPath} active createRequest={request} onCreateRequestHandled={handled} />))
  expect(handled).toHaveBeenCalledTimes(1)
  const editor = container.querySelector<HTMLInputElement>('.file-tree-inline-edit__input') ?? container.querySelector<HTMLInputElement>('[aria-label="File or folder name"]') ?? container.querySelector<HTMLInputElement>('input:not([type="search"])')
  expect(editor).toBeTruthy(); await input(editor!, 'Original unsaved filename')
  await act(async () => root.render(<FileExplorer workspaceId={scratchWorkspace.id} rootPath={rootPath} active={false} onCreateRequestHandled={handled} />))
  await act(async () => root.render(<FileExplorer workspaceId={scratchWorkspace.id} rootPath={rootPath} active onCreateRequestHandled={handled} />))
  expect(editor!.value).toBe('Original unsaved filename'); expect(editor!.isConnected).toBe(true)
  expect(handled).toHaveBeenCalledTimes(1)
})

let gitReader: ReturnType<typeof useGitStatus>
function GitReader({ active, workspaceId = scratchWorkspace.id }: { active: boolean; workspaceId?: string }) {
  gitReader = useGitStatus(workspaceId, active)
  return <div>{gitReader.error ?? (gitReader.status?.kind === 'git-repository' ? gitReader.status.branch : gitReader.status?.kind) ?? 'Not read'}</div>
}
it('original Git bridge pauses only automatic admission, keeps an admitted flight and supports explicit hidden refresh', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'agentmux'), pending = deferred<Awaited<ReturnType<NonNullable<Window['agentmux']>['git']['status']>>>()
  const snapshot = { kind: 'git-repository' as const, hostId: 'local', repoPath: scratchWorkspace.path, repoRelativePrefix: '', branch: 'original-main', changes: [] }
  const status = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot)
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status } } })
  try {
    await act(async () => root.render(<GitReader active={false} />)); expect(status).not.toHaveBeenCalled()
    await act(async () => root.render(<GitReader active />)); expect(status).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<GitReader active={false} />)); await act(async () => pending.resolve(snapshot))
    expect(container.textContent).toBe('original-main')
    await act(async () => root.render(<GitReader active />)); expect(status).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<GitReader active={false} />))
    status.mockRejectedValueOnce(new Error('Original Git observation unavailable'))
    await act(async () => { await gitReader.refresh() }); expect(gitReader.status).toEqual(snapshot); expect(container.textContent).toContain('Original Git observation unavailable')
    await act(async () => root.render(<GitReader active />)); expect(status).toHaveBeenCalledTimes(2)
    await act(async () => { await gitReader.refresh() }); expect(container.textContent).toBe('original-main')
  } finally {
    if (descriptor) Object.defineProperty(window, 'agentmux', descriptor); else Reflect.deleteProperty(window, 'agentmux')
  }
})

it('an uncertain original Goal mutation retains its exact retry operation across hide and reveal', async () => {
  const goal: DemandRecord = { id: 'retry-original-goal', title: 'Original retry Goal', description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null, sessionIds: [defaultAgent.id], createdAt: 1, updatedAt: 2, source: 'session' }
  const loop: ContinuousProgressLoop = { loopId: 'same-original-loop', agentSessionId: defaultAgent.id, hostId: scratchWorkspace.hostId, providerId: defaultAgent.providerId, workspacePath: scratchWorkspace.path, taskSource: { kind: 'goal', goalId: goal.id, alignmentRevision: 1 }, revision: 3, status: 'active', intervalMs: 60000, prompt: 'Original controlled work', nextCheckAt: 60000 }
  useAppStore.setState({ demands: { [goal.id]: goal } })
  vi.mocked(api.continuousProgress.goals).mockResolvedValue([loop])
  const action = vi.spyOn(api.continuousProgress, 'goalAction').mockRejectedValueOnce(new Error('Original mutation receipt unconfirmed')).mockResolvedValue(loop)
  const render = async (active: boolean) => { await act(async () => root.render(<GoalContinuationControl demand={goal} active={active} />)) }
  await render(true); await click('Check now')
  expect(container.textContent).toContain('Original mutation receipt unconfirmed')
  const operation = action.mock.calls[0]![4], inspections = vi.mocked(api.continuousProgress.goals).mock.calls.length
  expect(operation).toBeTruthy(); expect(action).toHaveBeenCalledTimes(1)
  await render(false); await render(true)
  expect(action).toHaveBeenCalledTimes(1); expect(api.continuousProgress.goals).toHaveBeenCalledTimes(inspections)
  await click('Inspect and retry original check')
  expect(action).toHaveBeenCalledTimes(2); expect(action.mock.calls[1]![4]).toBe(operation)
  expect(action.mock.calls[1]!.slice(0, 4)).toEqual([goal.id, loop.loopId, 'check', loop.revision])
  expect(container.textContent).not.toContain('Original mutation receipt unconfirmed')
})

it('the actual StrictMode effect replay retains the admitted saved-material response', async () => {
  const pending = deferred<FileReadResult>(); let params!: FileReadParams
  vi.mocked(api.files.readPublic).mockImplementation(request => { if (request.path !== 'BEHAVIOR.md') return Promise.resolve(material(request, '# Strict original saved SOUL')); params = request; return pending.promise })
  await act(async () => root.unmount()); root = createDomRoot(container)
  await act(async () => root.render(<StrictMode><DesktopClientUiProvider><MoteDetailsPanel scope={scope} onOpenPath={openPath} onCreateNote={createNote} /></DesktopClientUiProvider></StrictMode>))
  expect(api.files.readPublic).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(material(params, behavior.DEFAULT_MOTE_BEHAVIOR)))
  expect(container.textContent).not.toContain('Reading saved behavior')
  await act(async () => { const details = container.querySelector<HTMLDetailsElement>('.mote-details__soul')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(container.textContent).toContain('Strict original saved SOUL')
})
