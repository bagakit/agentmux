import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useWorkbenchBrowserPresentation, workbenchSessionStageHostId, type WorkbenchViewTargets } from '../src/renderer/src/lib/workbench-presentation'
import { workbenchProjectionSlotId, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Observe the actual parent context, then forward all props to the real Pane.
// Activity, Composer, Mailbox, shared message reader and production portals remain real.
vi.mock('../src/renderer/src/components/SessionPane', async importOriginal => {
  const module = await importOriginal<typeof import('../src/renderer/src/components/SessionPane')>()
  return { ...module, SessionPane: (props: Parameters<typeof module.SessionPane>[0]) => {
    const parent = useWorkbenchBrowserPresentation()
    return <div data-observed-primary-reference={JSON.stringify(parent.reference)} data-observed-resource-origin={JSON.stringify(props.linkOrigin)}>
      <module.SessionPane {...props} />
    </div>
  } }
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-isolated-terminal /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
const dom = composerDOM(), body = 'Original captured Workbench message'
const resourceId = 'resource-work', tabId = 'original-tab', regionId = 'actual-region'
const hasLocationProduct = existsSync(resolve(process.cwd(), 'apps/desktop/src/renderer/src/components/MailboxLocationContext.tsx'))
const references = ['a', 'b', 'c'].map(id => ({ displayWorkspaceId: 'display-' + id, groupId: 'group-' + id, tabId, regionId }))
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }); await act(async () => new Promise(resolve => setTimeout(resolve, 25))) }
function field(panel: HTMLElement, name: string) {
  const dt = [...panel.querySelectorAll('dt')].find(item => item.textContent === name)
  expect(dt, 'Real Info field ' + name).toBeDefined()
  return dt!.nextElementSibling!.textContent
}
async function openMessage(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>('.composer-mailbox')!
  expect(panel).not.toBeNull()
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel.dispatchEvent(event)); await flush()
  for (const selector of ['[role="tab"][id$="-inbox-tab"]', '.composer-mailbox__row', '[aria-label="Message details"]']) {
    const button = panel.querySelector<HTMLButtonElement>(selector)!
    expect(button, selector + ': ' + panel.textContent).not.toBeNull(); await act(async () => button.click()); await flush()
  }
  expect(panel.textContent).toContain(body)
  return panel
}
function fixture() {
  const catalog = spatialCatalog(useAppStore.getState(), [])
  const scopes: WorkbenchProjection[] = references.map((reference, index) => ({
    presentationId: 'actual-display-' + index, displayWorkspaceId: reference.displayWorkspaceId,
    entity: { kind: 'tab', tabId }, catalog, selection: [reference], onSelect: vi.fn()
  }))
  const targets: WorkbenchViewTargets = { [tabId]: references.map((reference, index) => ({
    hostId: workbenchProjectionSlotId(scopes[index]!.presentationId + '-slot', reference),
    active: true, visible: true, surface: index === 0 ? 'space' : 'survey', reference, projection: scopes[index]!
  })) }
  for (const reference of references) expect(catalog.locations.some(location =>
    location.displayWorkspaceId === reference.displayWorkspaceId && location.groupId === reference.groupId &&
    location.tabId === reference.tabId && location.regionId === reference.regionId)).toBe(true)
  return { targets, element: <>
    {scopes.map(scope => <WorkspaceWorkbench key={scope.presentationId} workspaceId={scope.displayWorkspaceId}
      viewOwnership="projection" projection={scope} viewTargets={targets} />)}
    <WorkspaceWorkbench workspaceId={resourceId} viewTargets={targets} />
  </> }
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 300, width: 640, height: 300, toJSON() {} }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value() {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'closed' }); this.dispatchEvent(event)
  } })
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'agent-1', source: { providerId: 'codex', nativeSessionId: 'native-a' }, items: [] })
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async () => useAppStore.getState().timelines['agent-1']!)
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source: { providerId: 'codex', nativeSessionId: 'native-a' }, dispose() {} })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  const tab = createWorkbenchTab(tabId, { kind: 'agent', phase: 'attached', regionId, workspaceId: resourceId, sessionId: 'agent-1' }, 'Original shared Tab')
  const decoy = createWorkbenchTab('decoy-first-tab', { kind: 'agent', phase: 'attached', regionId: 'decoy-region', workspaceId: resourceId, sessionId: 'agent-1' }, 'Wrong first Tab')
  useAppStore.setState({ activeWorkspaceId: resourceId, agentNames: {},
    config: { ...composerConfig, workspaces: [
      { id: 'project-root', name: 'Resource project', kind: 'folder', hostId: 'local', path: _hygiene_fixturePath("resource/project") },
      { id: resourceId, name: 'Resource worktree', kind: 'worktree', hostId: 'local', repoPath: _hygiene_fixturePath("resource/project"), path: _hygiene_fixturePath("resource/project/.worktrees/current") },
      ...references.map(reference => ({ id: reference.displayWorkspaceId, name: 'Display ' + reference.displayWorkspaceId, kind: 'folder' as const, hostId: 'local', path: _hygiene_fixturePath("display/") + reference.displayWorkspaceId }))
    ] }, tabs: { [decoy.id]: decoy, [tab.id]: tab },
    layouts: { [resourceId]: createWorkspaceLayout('resource-home', [decoy.id, tab.id]),
      ...Object.fromEntries(references.map(reference => [reference.displayWorkspaceId, createWorkspaceLayout(reference.groupId, [tabId])])) },
    sessions: [{ ...composerSession(), workspacePath: _hygiene_fixturePath("execution/original-cwd") }, composerSession('recorded-sender')], viewModes: { 'agent-1': 'activity' },
    timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 1, items: [{ id: 'recorded-submission', agentSessionId: 'agent-1', kind: 'user_message', status: 'complete', source: 'user', content: body, authorAgentSessionId: 'recorded-sender', createdAt: 1, updatedAt: 1 }] } },
    noticeReadReceipts: {}, agentSteerQueues: {}, agentSteerInFlight: {} })
})
it('real WorkspaceWorkbench produces the borrowed primary reference and independent secondary readers without duplicating the primary', async () => {
  const { element, targets } = fixture(), before = useAppStore.getState()
  const controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'submitMessage')]
  await dom.render(element); await flush()
  const hosts = targets[tabId]!.map(target => document.getElementById(target.hostId)!)
  expect(hosts.every(Boolean)).toBe(true)
  const primary = hosts[0]!.querySelector<HTMLElement>('[data-observed-primary-reference]')!
  expect(primary).not.toBeNull()
  expect(JSON.parse(primary.dataset.observedPrimaryReference!)).toEqual(references[0])
  expect(JSON.parse(primary.dataset.observedResourceOrigin!)).toEqual({ workspaceId: resourceId, tabGroupId: 'group-a', tabId, regionId, sessionId: 'agent-1' })
  // Every destination is made by actual projection Workbenches and their region slots.
  expect(hosts[0]!.querySelectorAll(`[data-session-presentation]`)).toHaveLength(0)
  for (let index = 1; index < hosts.length; index++) {
    const stage = hosts[index]!.querySelector<HTMLElement>('[data-session-presentation]')!
    expect(stage).not.toBeNull()
    expect(stage.dataset.sessionPresentation).toBe(workbenchSessionStageHostId(targets[tabId]![index]!, regionId))
    expect(stage.querySelector('.activity-feed')).not.toBeNull()
    expect(stage.querySelector('.agent-input-stack .composer-mailbox')).not.toBeNull()
  }
  const panel = await openMessage(primary)
  await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(api.ui.writeClipboardText).toHaveBeenCalledWith(body)
  if (hasLocationProduct) {
    expect(field(panel, '显示 Workspace ID')).toBe('display-a')
    expect(field(panel, 'Group ID')).toBe('group-a')
    expect(field(panel, '资源 Workspace ID')).toBe(resourceId)
    expect(field(panel, '当前执行 cwd')).toBe(_hygiene_fixturePath("execution/original-cwd"))
  }
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions); expect(after.layouts).toBe(before.layouts); expect(after.tabs).toBe(before.tabs)
  expect(after.sessions[0]!.control.run).toBe(before.sessions[0]!.control.run)
  expect(dom.draft()).toBe('Keep my draft')
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})
it('real secondary Workbench composers keep each exact address and focus only the clicked reader', async () => {
  const { element, targets } = fixture(); await dom.render(element); await flush()
  const stages = targets[tabId]!.slice(1).map(target => document.getElementById(workbenchSessionStageHostId(target, regionId))!)
  expect(stages.every(Boolean)).toBe(true)
  const panels = [] as HTMLElement[]
  for (const [index, stage] of stages.entries()) {
    const panel = await openMessage(stage); panels.push(panel)
    if (hasLocationProduct) {
      const reference = references[index + 1]!
      for (const [name, value] of Object.entries({ '显示 Workspace ID': reference.displayWorkspaceId, 'Group ID': reference.groupId,
        'Tab ID': reference.tabId, 'Region ID': reference.regionId, '资源 Workspace ID': resourceId, '当前执行 cwd': _hygiene_fixturePath("execution/original-cwd") })) expect(field(panel, name)).toBe(value)
    }
  }
  await act(async () => panels[1]!.querySelector<HTMLButtonElement>('.log-turn__actions .composer-mailbox__reveal')!.click()); await flush()
  expect(stages[0]!.querySelector('[data-message-located]')).toBeNull()
  const located = stages[1]!.querySelector('[data-message-located]')
  expect(located).not.toBeNull(); expect(document.activeElement).toBe(located)
  expect(dom.draft()).toBe('Keep my draft')
})
// The integration owner enables this assertion after applying the separately frozen location product.
// A missing product cannot be reported as a successful address/Info assertion.
it.skipIf(!hasLocationProduct)('combined real Workbench → Pane → Composer → shared Info shows primary and both secondary addresses', async () => {
  const { element, targets } = fixture(); await dom.render(element); await flush()
  for (const [index, target] of targets[tabId]!.entries()) {
    const host = document.getElementById(target.hostId)!, panel = await openMessage(host), reference = references[index]!
    for (const [name, value] of Object.entries({ '显示 Workspace ID': reference.displayWorkspaceId, 'Group ID': reference.groupId,
      'Tab ID': reference.tabId, 'Region ID': reference.regionId, '资源 Workspace ID': resourceId,
      '项目根目录': _hygiene_fixturePath("resource/project"), 'Workspace / worktree 目录': _hygiene_fixturePath("resource/project/.worktrees/current"), '当前执行 cwd': _hygiene_fixturePath("execution/original-cwd") })) expect(field(panel, name)).toBe(value)
  }
})
