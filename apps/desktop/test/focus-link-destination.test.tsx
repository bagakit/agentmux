import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Retained draft" defaultValue="KEEP" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: ({ surface }: { surface: { workspaceId: string; path: string } }) => {
  const document = useAppStore(state => state.documents[documentKey(surface.workspaceId, surface.path)])
  return <pre data-file-content>{document?.content}</pre>
} }))
import { ConversationFiles } from '@agentmux/client-ui/components/ConversationFiles'
import { AgentMarkdown } from '@agentmux/client-ui'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import { executionHostProjection } from '../src/renderer/src/lib/region-execution-host'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { FocusSettingsPane } from '../src/renderer/src/components/settings/FocusSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { openSessionFileLink, sessionFileRegionAvailable, useSessionLinkOpening } from '../src/renderer/src/lib/session-link-opening'
import { createSessionProjectFileContextSelector } from '../src/renderer/src/lib/session-project-file-context'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { directoryIdentity } from '../src/shared/space-addresses'
import { documentKey, workbenchSurfaces } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { targetSid, regionIdA, regionIdB, tabId } from './helpers/workface-control-fixture'
import { startWorkfaceFileFixture, fileCatalog, zoneFor } from './helpers/workface-file-fixture'

const initial = useAppStore.getState()
const origin = { workspaceId: 'display', tabGroupId: 'display-group', tabId, regionId: regionIdA, sessionId: targetSid }
const reference = { displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId, regionId: regionIdA }
let fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>>, container: HTMLDivElement, root: ReturnType<typeof createRoot>
const context = () => createSessionProjectFileContextSelector(targetSid, origin)(useAppStore.getState())
const file = () => workbenchSurfaces(useAppStore.getState().tabs[tabId]!).find(surface => surface.kind === 'file')!
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  fixture = await startWorkfaceFileFixture()
  useAppStore.setState({ mainSurface: 'agents', agentFocus: { execution: { sessionId: targetSid, reference,
    history: [{ sessionId: targetSid, focusedAt: 1 }] }, pmo: { sessionId: null } } })
  expect(context().kind).toBe('session')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await fixture.stop();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true) })

function Links() {
  const links = useSessionLinkOpening(origin)
  return <><AgentMarkdown content={'Open `review.md:8` and [site](https://example.invalid/work).'} workspaceRoot={_hygiene_fixturePath("private/workface-execution")}
    openWorkspaceFile={links.activateFile} openHttpLink={links.activateHttp} />
    {links.request ? <button onClick={() => links.choose('tab')}>Choose Tab</button> : null}</>
}
async function flush() { await act(async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }) }

describe('Focus original File and link destinations', () => {
  it('adds only a File Region to the exact original Tab and shows its original content in region-only Focus', async () => {
    const before = useAppStore.getState(), agent = before.tabs[tabId]!.regions[regionIdA], history = before.agentFocus.execution.history
    await openSessionFileLink(origin, context(), 'review.md', { line: 8, column: 2 }, 'right')
    const state = useAppStore.getState(), target = file()
    expect(target?.kind).toBe('file'); expect(Object.keys(state.tabs)).toEqual(Object.keys(before.tabs))
    expect(state.tabs[tabId]!.regions[regionIdA]).toBe(agent); expect(state.sessions).toBe(before.sessions)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts); expect(state.agentFocus.execution.history).toBe(history)
    expect(state.mainSurface).toBe('agents'); expect(state.agentFocus.execution.reference).toEqual({ ...reference, regionId: target.regionId })
    expect(state.documentRevealTargets[documentKey('resource', 'review.md')]).toEqual({ line: 8, column: 2 })
    const projection = executionFocusPresentation(state.agentFocus.execution, state.tabs, fileCatalog(), () => {}, 'region').projection
    expect(projection?.entity).toEqual({ kind: 'region', regionId: target.regionId })
    if (target.kind !== 'file') throw new Error('Expected actual File surface')
    await act(async () => root.render(<FileSurfaceView tabId={tabId} surface={target} />)); await flush()
    expect(container.querySelector('[data-file-content]')?.textContent).toContain('Current readable source')
    fixture.noLifecycle()
  })
  it('reuses the same File Region and dirty document while keeping siblings intact', async () => {
    await openSessionFileLink(origin, context(), 'review.md', undefined, 'right')
    const target = file(); expect(target.kind).toBe('file')
    useAppStore.getState().updateDocument(tabId, 'UNSAVED', target.regionId)
    const before = useAppStore.getState(), document = before.documents[documentKey('resource', 'review.md')]
    await openSessionFileLink(origin, context(), 'review.md', undefined, 'left')
    expect(workbenchSurfaces(useAppStore.getState().tabs[tabId]!).filter(surface => surface.kind === 'file')).toHaveLength(1)
    expect(useAppStore.getState().documents[documentKey('resource', 'review.md')]).toBe(document)
    expect(useAppStore.getState().dirtyDocuments[documentKey('resource', 'review.md')]).toBe(true)
    expect(useAppStore.getState().tabs[tabId]!.regions[regionIdB]).toBe(before.tabs[tabId]!.regions[regionIdB])
    expect(api.files.read).toHaveBeenCalledTimes(1)
  })
  it('explicit Tab opens the actual resource in Space, not an invisible Focus Tab', async () => {
    await openSessionFileLink(origin, context(), 'review.md', undefined, 'tab')
    const state = useAppStore.getState(); expect(state.mainSurface).toBe('workbench')
    expect(state.activeWorkspaceId).toBe('resource'); expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: 'resource', groupId: 'resource-group' })
    const choice = state.workbenchSpaceSelection!
    expect(state.tabs[choice.tabId!]!.regions[choice.regionId!]).toMatchObject({ kind: 'file', workspaceId: 'resource', path: 'review.md' })
    expect(state.tabs[tabId]!.regions[regionIdA]).toMatchObject({ kind: 'agent', sessionId: targetSid }); fixture.noLifecycle()
  })
  it('does not take navigation back after a later same-Session occurrence choice', async () => {
    let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = openSessionFileLink(origin, context(), 'late.md', undefined, 'tab')
    const settled = pending.then(() => null, error => error as Error)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const state = useAppStore.getState()
    useAppStore.setState({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, reference: { ...reference, regionId: regionIdB } } } })
    release({ status: 'read', document: { path: 'late.md', content: 'Late retained data', revision: '1' } }); const failure = await settled
    expect(failure).toBeInstanceOf(Error); expect(failure?.message).toMatch(/later selection/i)
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().agentFocus.execution.reference?.regionId).toBe(regionIdB)
  })
  it('reports directory and failed read without creating a replacement work surface', async () => {
    const ids = Object.keys(useAppStore.getState().tabs), original = useAppStore.getState().tabs[tabId]
    vi.mocked(api.files.read).mockResolvedValueOnce({ status: 'directory' })
    await expect(openSessionFileLink(origin, context(), 'folder', undefined, 'right')).rejects.toThrow(/directory/i)
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(ids); expect(useAppStore.getState().tabs[tabId]).toBe(original)
    vi.mocked(api.files.read).mockRejectedValueOnce(new Error('Private failed read'))
    await expect(openSessionFileLink(origin, context(), 'failed.md', undefined, 'right')).rejects.toThrow(/failed read/i)
    expect(useAppStore.getState().tabs[tabId]).toBe(original)
  })
  it('refuses cross-resource Region and preserves the exact Agent', async () => {
    const original = useAppStore.getState().tabs[tabId], scoped = context(), config = useAppStore.getState().config!
    const foreign = { ...scoped, placement: { ...scoped.placement!, resource: { hostId: 'local', path: config.workspaces[1]!.path } } }
    expect(sessionFileRegionAvailable(origin, foreign)).toBe(false)
    await expect(openSessionFileLink(origin, foreign, 'review.md', undefined, 'right')).rejects.toThrow(/another resource or Zone/i)
    expect(useAppStore.getState().tabs[tabId]).toBe(original); expect(api.files.read).not.toHaveBeenCalled()
  })
  it('manual Markdown file click uses the saved default and Alt keeps the explicit chooser', async () => {
    await act(async () => root.render(<Links />))
    const fileLink = container.querySelector<HTMLButtonElement>('.md-link--file')!
    expect(fileLink).not.toBeNull()
    await act(async () => fileLink.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
    expect(container.textContent).toContain('Choose Tab'); expect(api.files.read).not.toHaveBeenCalled()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Choose Tab')!.click()); await flush()
    expect(useAppStore.getState().mainSurface).toBe('workbench')
  })
  it('SessionPane actual Conversation file consumer reveals the File while keeping its original Agent', async () => {
    useAppStore.setState({ viewModes: { [targetSid]: 'activity' }, timelines: { [targetSid]: { agentSessionId: targetSid, revision: 1,
      items: [{ id: 'findings', agentSessionId: targetSid, kind: 'assistant_message', title: 'Findings', content: 'Read `review.md:8`.',
        source: 'native-hook', status: 'complete', createdAt: 100, updatedAt: 100 }] } } })
    await act(async () => root.render(<SessionPane sessionId={targetSid} surfaceKind="agent" visible interactiveResize={false} linkOrigin={origin} />)); await flush()
    const link = container.querySelector<HTMLButtonElement>('.md-link--file')!; expect(link).not.toBeNull()
    await act(async () => link.click()); await flush()
    expect(file().kind).toBe('file'); expect(useAppStore.getState().agentFocus.execution.reference?.tabId).toBe(tabId)
    expect(useAppStore.getState().tabs[tabId]!.regions[regionIdA]).toMatchObject({ kind: 'agent', sessionId: targetSid })
  })
  it('a real Markdown file accelerator opens the system application without creating a Region', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    await act(async () => root.render(<Links />))
    const before = useAppStore.getState().tabs, system = vi.spyOn(api.files, 'openSystem').mockResolvedValue(undefined)
    await act(async () => container.querySelector<HTMLButtonElement>('.md-link--file')!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
    await flush(); expect(system).toHaveBeenCalledExactlyOnceWith('resource', 'review.md')
    expect(useAppStore.getState().tabs).toBe(before); expect(api.files.read).not.toHaveBeenCalled()
  })
  it('the reply Files footer preserves Alt and system gestures instead of hiding an independent file entry', async () => {
    function Footer() {
      const links = useSessionLinkOpening(origin)
      return <><ConversationFiles files={[{ name: 'review.md', kind: 'document', reference: { path: 'review.md', line: 8, index: 0, length: 9 } }]} openFile={links.activateFile} />
        {links.request ? <span>Destination requested</span> : null}</>
    }
    await act(async () => root.render(<Footer />))
    const button = container.querySelector<HTMLButtonElement>('.conversation-file')!; expect(button).not.toBeNull()
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
    expect(container.textContent).toContain('Destination requested'); expect(api.files.read).not.toHaveBeenCalled()
  })
  it('a mapped foreign Goal resource offers an explicit Tab without reading into or replacing the original Agent Region', async () => {
    const before = useAppStore.getState(), project = before.config!.workspaces.find(workspace => workspace.id === 'display')!
    useAppStore.setState({ demandPmoTabIds: { 'actual-goal': tabId }, demands: { 'actual-goal': { id: 'actual-goal', title: 'Foreign project',
      description: '', status: 'backlog', priority: 'normal', projectId: directoryIdentity(project.hostId, project.path), projectName: project.name,
      sessionIds: [], createdAt: 1, updatedAt: 1, source: 'session' } } })
    expect(context().kind).toBe('goal'); expect(context().project?.workspaceId).toBe('display')
    await act(async () => root.render(<Links />))
    await act(async () => container.querySelector<HTMLButtonElement>('.md-link--file')!.click())
    expect(container.textContent).toContain('Choose Tab'); expect(api.files.read).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[tabId]).toBe(before.tabs[tabId])
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Choose Tab')!.click()); await flush()
    const state = useAppStore.getState(), choice = state.workbenchSpaceSelection!
    expect(state.mainSurface).toBe('workbench'); expect(state.activeWorkspaceId).toBe('display')
    expect(state.tabs[choice.tabId!]!.regions[choice.regionId!]).toMatchObject({ kind: 'file', workspaceId: 'display', path: 'review.md' })
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith('display', 'review.md')
    expect(state.tabs[tabId]!.regions[regionIdA]).toBe(before.tabs[tabId]!.regions[regionIdA]); fixture.noLifecycle()
  })
  it('an ordinary HTTP click obeys a saved Tab default and navigates to the actual Space Browser', async () => {
    useAppStore.setState(state => ({ config: { ...state.config!, focus: { recentActivityHours: 48, ...state.config!.focus, linkDestination: 'tab' } } }))
    await act(async () => root.render(<Links />))
    const link = [...container.querySelectorAll<HTMLElement>('.md-link')].find(link => link.textContent === 'site')!
    expect(link).toBeDefined(); await act(async () => link.click()); await flush()
    const state = useAppStore.getState()
    expect(state.mainSurface).toBe('workbench'); expect(Object.values(state.tabs).flatMap(tab => workbenchSurfaces(tab)).some(surface => surface.kind === 'browser')).toBe(true)
    expect(container.textContent).not.toContain('Choose Tab'); fixture.noLifecycle()
  })
  it('Settings renders Region/Tab defaults and saves a selected link destination with its expected value', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(<FocusSettingsPane recentActivityHours={48} onSave={save} />))
    const radios = container.querySelectorAll<HTMLInputElement>('input[name="focus-link-destination"]')
    expect(radios).toHaveLength(2); expect(radios[0]!.checked).toBe(true)
    await act(async () => radios[1]!.click())
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save changes')!; expect(button).not.toBeNull()
    await act(async () => button.click()); expect(save).toHaveBeenCalledExactlyOnceWith(48, 48, 'tab', 'region')
  })
  it('a Browser link selects the actual new Region in region-only Focus without replacing the Agent', async () => {
    const before = useAppStore.getState(), agent = before.tabs[tabId]!.regions[regionIdA]
    await before.openHttpLink(origin, 'https://example.invalid/source', 'right')
    const state = useAppStore.getState(), browser = workbenchSurfaces(state.tabs[tabId]!).find(surface => surface.kind === 'browser')!
    expect(browser?.kind).toBe('browser'); expect(Object.keys(state.tabs)).toEqual(Object.keys(before.tabs))
    expect(state.agentFocus.execution.reference).toEqual({ ...reference, regionId: browser.regionId })
    expect(state.mainSurface).toBe('agents'); expect(state.tabs[tabId]!.regions[regionIdA]).toBe(agent)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(executionFocusPresentation(state.agentFocus.execution, state.tabs, fileCatalog(), () => {}, 'region').projection?.entity)
      .toEqual({ kind: 'region', regionId: browser.regionId }); fixture.noLifecycle()
  })
  it('a Browser completion keeps a later exact same-Session Region choice', async () => {
    const create = api.browser.create; let release!: () => void
    vi.spyOn(api.browser, 'create').mockImplementation(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return create(...args) })
    const pending = useAppStore.getState().openHttpLink(origin, 'https://example.invalid/late', 'right')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    useAppStore.setState(state => ({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution,
      reference: { ...reference, regionId: regionIdB } } } }))
    release(); await pending
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual({ ...reference, regionId: regionIdB })
    expect(useAppStore.getState().mainSurface).toBe('agents'); fixture.noLifecycle()
  })
  it('the independent Activity presentation consumes the same ordinary File destination and preserves its draft', async () => {
    const item = { id: 'independent-findings', agentSessionId: targetSid, kind: 'assistant_message' as const, title: 'Findings',
      content: 'Read `review.md:8`.', source: 'native-hook' as const, status: 'complete' as const, createdAt: 100, updatedAt: 100 }
    const target = { hostId: 'independent-activity', active: true, visible: true, surface: 'focus' as const, reference }
    await act(async () => root.render(<SessionActivityPresentation target={target} regionId={regionIdA} sourceKey="same-original-session"
      sessionId={targetSid} name="Original Agent" executorLabel="Original CLI" executionHost={executionHostProjection('local', _hygiene_fixturePath("private/workface-execution"))}
      activity={{ sessionId: targetSid, items: [item], capability: 'complete-events' }} eligible readOnly={false} resourceOrigin={origin}
      composer={<textarea aria-label="Independent retained draft" defaultValue="KEEP INDEPENDENT" />}
      renderFrame={content => content} selectRegion={() => {}} />)); await flush()
    const draft = container.querySelector<HTMLTextAreaElement>('textarea')!, link = container.querySelector<HTMLButtonElement>('.md-link--file')!
    expect(draft.value).toBe('KEEP INDEPENDENT'); expect(link).not.toBeNull()
    await act(async () => link.click()); await flush()
    expect(file().kind).toBe('file'); expect(container.querySelector('textarea')).toBe(draft)
    expect(useAppStore.getState().agentFocus.execution.reference?.regionId).toBe(file().regionId)
    fixture.noLifecycle()
  })
  it('public file.open through the actual CLI and Store inserts a Region and returns its actual File address', async () => {
    const zone = zoneFor('resource')
    const result = await fixture.run('file.open', ['file', 'open', '--zone', zone.zoneId, '--path', 'cli.md', '--tab', tabId,
      '--region', regionIdA, '--split', 'right', '--display-workspace', 'display', '--group', 'display-group'])
    expect(result).toMatchObject({ placement: { status: 'created', tabId }, navigation: 'background', changed: true, outcome: 'opened' })
    expect(result.placement.regionId).not.toBe(regionIdA)
    expect(result.placement.locations).toContainEqual(expect.objectContaining({ tabId, regionId: result.placement.regionId, displayWorkspaceId: 'display', groupId: 'display-group' }))
    expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
    fixture.noLifecycle()
  })
})
