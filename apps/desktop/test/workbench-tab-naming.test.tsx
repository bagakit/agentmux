import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { AgentMuxSpatialStateStore, displayLabel, type AgentMuxNameContext } from '../../../packages/core/src/spatial-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { tabRenameTargets, useWorkbenchTabRename, useWorkbenchTabNameTooltip, WorkbenchTabRenameFeedback, type TabNameTarget } from '../src/renderer/src/components/WorkbenchTabNaming'
import { WorkbenchTabContextMenu } from '../src/renderer/src/components/WorkbenchTabContextMenu'
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice'
import type { SessionSnapshot } from '../src/shared/contracts'

const sid = 'tab-naming-original-agent', tabId = 'tab-naming-original-tab'
const session = { id: sid, kind: 'agent', providerId: 'codex', label: 'Original name' } as SessionSnapshot
const surface = { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'original-workspace', sessionId: sid } as const
const single = (name?: string) => createWorkbenchTab(tabId, surface, name)
const facts = [session], names = { [sid]: 'Original name' }
let root: Root | undefined, host: HTMLDivElement, directory: string | undefined
let latest: ReturnType<typeof useWorkbenchTabRename>
let setSurfaceVisible: (visible: boolean) => void
const context: AgentMuxNameContext = { actor: { kind: 'device', id: 'private-test-editor', verified: true }, source: 'desktop-ui',
  entryPoint: 'private-current-production-tab-editor', transport: 'electron-ipc', location: { tabId } }
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined
  host?.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined
  vi.unstubAllGlobals()
})
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 10)) })
async function ownerFixture() {
  directory = await mkdtemp(join(tmpdir(), 'amux-tab-names-'))
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  await owner.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {}, resources: {},
    tabs: [{ tabId, workspaceId: 'original-workspace', zoneId: null, name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId, kind: 'agent', agentSessionId: sid, runId: 'original-run', execution: { hostId: 'local', cwd: _hygiene_fixturePath("original-cwd") } }],
    tabLayouts: { [tabId]: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } } } })
  return owner
}
async function mount(targets: TabNameTarget[], save: (target: TabNameTarget, value: string | null, revision: number) => Promise<boolean>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  function Harness() {
    const renameInput = useRef<HTMLInputElement>(null)
    const [visible, setVisible] = useState(true); setSurfaceVisible = setVisible
    latest = useWorkbenchTabRename({ targets, displayName: 'Original name', revision: () => 0, save })
    const tooltip = useWorkbenchTabNameTooltip('完整中文 Tab 名 · Long untruncated original work description', 'Agent and Browser', !visible || latest.rename !== null)
    return <><WorkbenchTabContextMenu tabId={tabId} copyableAgentSessionId={sid} regionCount={1}
      canCloseOthers={false} canCloseLeft={false} canCloseRight={false} canMoveToNewGroup={false}
      writeClipboardText={async () => {}} onRenameTab={latest.begin} renameLabel={latest.label}
      onClose={() => {}} onCloseOthers={() => {}} onCloseLeft={() => {}} onCloseRight={() => {}} onMoveToNewGroup={() => {}}
      onArrange={() => {}} moveSessionViewTargets={[]} onMoveSessionView={() => {}} displayTargets={[]} bindingPending={false}
      onOpenChange={() => {}} onDisplayBindingChange={() => {}}>
      <button data-tab-trigger {...tooltip.props}>Original name</button>
    </WorkbenchTabContextMenu>{tooltip.content}{latest.rename ? <input ref={renameInput} aria-label={latest.rename.label} value={latest.rename.value} readOnly /> : null}
    <WorkbenchTabRenameFeedback anchor={renameInput} notice={visible ? latest.rename?.incomplete ?? null : null}>
      <ServiceWindowNotice notice={latest.rename?.incomplete ?? null} />
    </WorkbenchTabRenameFeedback></>
  }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<Harness />))
}

it('uses actual Region count, full naming facts and explicit overrides for the rename scope', () => {
  expect(tabRenameTargets(single(), facts, names, {})).toEqual([{ kind: 'agent-session', id: sid }])
  expect(tabRenameTargets(single('Original name'), facts, names, {})).toEqual([{ kind: 'agent-session', id: sid }, { kind: 'tab', id: tabId }])
  expect(tabRenameTargets(single('Separate tab'), facts, names, {})).toEqual([{ kind: 'tab', id: tabId }])
  const sameSidTwice = addWorkbenchRegion(single(), 'original-region', 'right', { ...surface, regionId: 'second-region' })!
  expect(tabRenameTargets(sameSidTwice, facts, names, {})).toEqual([{ kind: 'tab', id: tabId }])
  const mixed = addWorkbenchRegion(single(), 'original-region', 'right', { kind: 'browser', regionId: 'browser-region', workspaceId: 'original-workspace', browserId: 'browser', url: 'about:blank' })!
  expect(tabRenameTargets(mixed, facts, names, {})).toEqual([{ kind: 'tab', id: tabId }])
  expect(tabRenameTargets(single(), [], names, {})).toEqual([{ kind: 'tab', id: tabId }])
  const file = createWorkbenchTab(tabId, { kind: 'file', regionId: 'file-region', workspaceId: 'original-workspace', path: 'README.md' })
  expect(tabRenameTargets(file, facts, names, {})).toEqual([{ kind: 'tab', id: tabId }])
})

it.each([false, true])('the actual menu renders one accurate rename action (combined=%s)', async combined => {
  await mount(combined ? tabRenameTargets(single('Original name'), facts, names, {}) : [{ kind: 'tab', id: tabId }], async () => true)
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 20 })))
  await settle()
  const renames = [...document.querySelectorAll('[role="menuitem"]')].filter(node => node.textContent?.startsWith('Rename'))
  expect(renames.map(node => node.textContent)).toEqual([combined ? 'Rename tab and agent' : 'Rename tab'])
  await act(async () => (renames[0] as HTMLElement).click())
  expect(latest.rename?.targets.map(item => item.target)).toEqual(combined ? [{ kind: 'agent-session', id: sid }, { kind: 'tab', id: tabId }] : [{ kind: 'tab', id: tabId }])
})

it('commits both explicit equal names to the real durable Core owner and keeps original spatial identity', async () => {
  const owner = await ownerFixture(), before = (await owner.read())!.graph
  const save = vi.fn(async (target: TabNameTarget, value: string | null, revision: number) => {
    const result = await owner.mutateDisplayLabel({ operationId: crypto.randomUUID(), target, value, source: 'manual', expectedNameRevision: revision }, context)
    return result.applied && result.diskDurability === 'confirmed'
  })
  await mount(tabRenameTargets(single('Original name'), facts, names, {}), save)
  await act(async () => latest.begin()); await act(async () => latest.change('New shared name')); await act(async () => latest.commit())
  expect(latest.rename).toBeNull(); expect(save.mock.calls.map(call => call[0].kind)).toEqual(['agent-session', 'tab'])
  const after = (await new AgentMuxSpatialStateStore(owner.path).read())!.graph
  expect(displayLabel(after, { kind: 'agent-session', id: sid })?.value).toBe('New shared name')
  expect(after.tabs[0]!.name).toBe('New shared name'); expect(after.regions).toEqual(before.regions); expect(after.tabLayouts).toEqual(before.tabLayouts)
  expect((await owner.queryNameChanges()).records).toHaveLength(2)
})

it('retains newer input across both ACKs and advances each confirmed revision independently', async () => {
  const owner = await ownerFixture(), releases: (() => void)[] = []
  const save = vi.fn(async (target: TabNameTarget, value: string | null, revision: number) => {
    const result = await owner.mutateDisplayLabel({ operationId: crypto.randomUUID(), target, value, source: 'manual', expectedNameRevision: revision }, context)
    await new Promise<void>(done => releases.push(done)); return result.applied && result.diskDurability === 'confirmed'
  })
  await mount([{ kind: 'agent-session', id: sid }, { kind: 'tab', id: tabId }], save)
  await act(async () => latest.begin()); await act(async () => latest.change('First'))
  let flight: Promise<void>; await act(async () => { flight = latest.commit() })
  await vi.waitFor(() => expect(releases).toHaveLength(1)); await act(async () => latest.change('Newer draft'))
  await act(async () => releases[0]!()); await vi.waitFor(() => expect(releases).toHaveLength(2))
  await act(async () => { releases[1]!(); await flight! })
  expect(latest.rename?.value).toBe('Newer draft'); expect(latest.rename?.targets.map(item => item.revision)).toEqual([1, 1])
})

it('keeps a failed second target editable without replaying the first confirmed target', async () => {
  let secondAttempts = 0
  const save = vi.fn(async (target: TabNameTarget) => target.kind === 'agent-session' || ++secondAttempts > 1)
  await mount([{ kind: 'agent-session', id: sid }, { kind: 'tab', id: tabId }], save)
  await act(async () => latest.begin()); await act(async () => latest.change('Shared draft'))
  const editor = host.querySelector('input')!; await act(async () => editor.focus())
  await act(async () => latest.commit())
  expect(latest.rename?.value).toBe('Shared draft'); expect(latest.rename?.targets.map(item => item.revision)).toEqual([1, 0])
  expect(latest.rename?.incomplete?.notice.step).toBe('Tab name change is unconfirmed')
  expect(latest.rename?.incomplete?.notice.mode).toContain('Agent name confirmed as "Shared draft".')
  expect(latest.rename?.incomplete?.notice.mode).toContain('Tab change to "Shared draft" has no confirmed result.')
  const feedback = document.querySelector('[role="status"]')!
  expect(feedback.textContent).toContain('Agent name confirmed as "Shared draft".')
  expect(feedback.textContent).toContain('Tab change to "Shared draft" has no confirmed result.')
  expect(host.contains(feedback)).toBe(false); expect(document.activeElement).toBe(editor)
  await act(async () => latest.commit('blur')); expect(save).toHaveBeenCalledTimes(2)
  await act(async () => latest.commit())
  expect(save.mock.calls.map(call => call[0].kind)).toEqual(['agent-session', 'tab', 'tab']); expect(latest.rename).toBeNull()
})

it('does not close or replace a newer editor after the original pending edit is cancelled', async () => {
  let release!: () => void
  await mount([{ kind: 'tab', id: tabId }], async () => { await new Promise<void>(done => { release = done }); return true })
  await act(async () => latest.begin()); let flight: Promise<void>; await act(async () => { flight = latest.commit() })
  await act(async () => { latest.cancel(); latest.begin() }); await act(async () => latest.change('Reopened draft'))
  await act(async () => { release(); await flight! }); expect(latest.rename?.value).toBe('Reopened draft')
})

it('does not send the unsubmitted Tab edit after Escape and reopening while the Agent ACK is pending', async () => {
  let release!: () => void, requests = 0
  const save = vi.fn(async () => { if (++requests === 1) await new Promise<void>(done => { release = done }); return true })
  await mount([{ kind: 'agent-session', id: sid }, { kind: 'tab', id: tabId }], save)
  await act(async () => latest.begin()); await act(async () => latest.change('Submitted shared name'))
  let flight: Promise<void>; await act(async () => { flight = latest.commit() })
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => { latest.cancel(); latest.begin() }); await act(async () => latest.change('Reopened draft'))
  await act(async () => { release(); await flight! })
  expect(save.mock.calls).toHaveLength(1); expect(latest.rename?.value).toBe('Reopened draft')
  expect(latest.rename?.targets.map(item => item.revision)).toEqual([0, 0])
})

it('shows the complete name on actual hover/focus outside the strip without changing focus', async () => {
  await mount([{ kind: 'tab', id: tabId }], async () => true)
  const trigger = host.querySelector('button')!; const other = document.createElement('input'); document.body.append(other); other.focus()
  await act(async () => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await settle(); const tooltip = document.querySelector('[role="tooltip"]')!
  expect(tooltip?.textContent).toContain('完整中文 Tab 名 · Long untruncated original work description')
  expect(host.contains(tooltip)).toBe(false); expect(document.activeElement).toBe(other)
  await act(async () => trigger.focus()); expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id)
  await act(async () => latest.begin()); expect(document.querySelector('[role="tooltip"]')).toBeNull(); other.remove()
})

it('hides both portals with the original surface and restores partial feedback without losing or replaying its draft', async () => {
  const save = vi.fn(async (target: TabNameTarget) => target.kind === 'agent-session')
  await mount([{ kind: 'agent-session', id: sid }, { kind: 'tab', id: tabId }], save)
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(document.querySelector('[role="tooltip"]')).toBeTruthy()
  await act(async () => setSurfaceVisible(false)); expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => setSurfaceVisible(true)); expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => latest.begin()); await act(async () => latest.change('Retained hidden draft'))
  await act(async () => setSurfaceVisible(false)); await act(async () => latest.commit())
  expect(latest.rename?.incomplete).toBeTruthy(); expect(document.querySelector('[role="status"]')).toBeNull()
  await act(async () => setSurfaceVisible(true))
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Agent name confirmed as "Retained hidden draft".')
  await act(async () => setSurfaceVisible(false)); expect(document.querySelector('[role="status"]')).toBeNull()
  await act(async () => setSurfaceVisible(true)); expect(latest.rename?.value).toBe('Retained hidden draft')
  expect(save).toHaveBeenCalledTimes(2)
})

it('the actual sortable Tab button merges both descriptions after the sortable attribute spread', () => {
  const file = readFileSync(join(process.cwd(), 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'), 'utf8')
  const tree = ts.createSourceFile('WorkspaceWorkbench.tsx', file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let tab: ts.JsxOpeningElement | undefined
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === 'button' &&
      node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'data-workbench-tab-id')) tab = node
    ts.forEachChild(node, visit)
  }
  visit(tree); expect(tab, 'nonempty actual production Tab button').toBeTruthy()
  const properties = [...tab!.attributes.properties]
  const spread = properties.findIndex(property => ts.isJsxSpreadAttribute(property) && property.expression.getText(tree) === 'attributes')
  const description = properties.findIndex(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'aria-describedby')
  expect(description).toBeGreaterThan(spread); expect(spread).toBeGreaterThan(-1)
  const attribute = properties[description] as ts.JsxAttribute
  expect(ts.isJsxExpression(attribute.initializer!)).toBe(true)
  const expression = (attribute.initializer as ts.JsxExpression).expression!.getText(tree)
  const applyActual = new Function('attributes', 'nameTooltip', `return (${expression})`) as
    (attributes: Record<string, string>, tooltip: { props: Record<string, string | undefined> }) => string | undefined
  expect(applyActual({ 'aria-describedby': 'drag-help' }, { props: { 'aria-describedby': 'full-tab-name' } })).toBe('drag-help full-tab-name')
  expect(applyActual({ 'aria-describedby': 'drag-help' }, { props: {} })).toBe('drag-help')
  expect(applyActual({}, { props: { 'aria-describedby': 'full-tab-name' } })).toBe('full-tab-name')
  expect(file).toContain('<WorkbenchTabRenameFeedback anchor={renameInput} notice={visible ? rename?.incomplete ?? null : null}>')
  expect(file).toContain('<ServiceWindowNotice notice={rename?.incomplete ?? null} />')
  expect(file).toContain("onBlur={() => void naming.commit('blur')}")
  expect(file).toContain('!visible || bindingMenuOpen || rename !== null || isDragging')
  const tabs: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = []
  const visitTabs = (node: ts.Node) => { if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === 'SortableWorkbenchTab') tabs.push(node); ts.forEachChild(node, visitTabs) }
  visitTabs(tree); expect(tabs).toHaveLength(2)
  expect(tabs.map(node => node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'visible')?.getText(tree))).toEqual(['visible={surfaceVisible}', 'visible={visible}'])
  const focus = readFileSync(join(process.cwd(), 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'), 'utf8')
  expect(focus).toContain('const visible = hostVisible && surfaceVisible')
  expect(focus).toContain('viewOwnership="projection" viewTargets={viewTargets} visible={visible}')
})
