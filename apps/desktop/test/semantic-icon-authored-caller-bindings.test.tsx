// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import type { ObjectLinkReference } from '@agentmux/client-ui/platform'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
import { ComposerLayoutToggle } from '../../../packages/client-ui/src/components/ComposerLayoutToggle'
import { PromptReactionIconView } from '../../../packages/client-ui/src/components/ConversationReactionActions'
import { InlineObjectLink } from '../src/renderer/src/components/InlineObjectLink'
import { AgentTopologySummary } from '../src/renderer/src/components/AgentTopologySummary'
import { FileDataPreview } from '../src/renderer/src/components/FileDataPreview'
import { FocusContextStateMark } from '../src/renderer/src/components/FocusContextState'
import { SessionConnectingSurface } from '../src/renderer/src/components/SessionConnectingSurface'
import { SessionRecoveryActions } from '../src/renderer/src/components/SessionRecoveryActions'
import { BrowserOperationStatus, BrowserReplayPreview } from '../src/renderer/src/components/BrowserOperationSurface'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { BrowserOperation, BrowserReplayPlan } from '../src/shared/browser-operation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
let release: () => void
beforeEach(() => { release = mountThemeRuntime(window) })
afterEach(() => release())
function drawing(element: ParentNode, id: SemanticIconId) {
  expect(element.querySelector(`use[href="${semanticIconHref(id)}"]`), `actual mounted ${id}`).not.toBeNull()
}
async function click(node: Element | null) {
  expect(node).not.toBeNull()
  await act(async () => { (node as HTMLElement).click() })
}

it.each([
  ['region', { kind: 'region', regionId: 'original-region' }, 'object.region'],
  ['tab', { kind: 'tab', tabId: 'original-tab' }, 'object.tab'],
  ['space', { kind: 'space', spaceId: 'original-space' }, 'object.spaces'],
  ['zone', { kind: 'zone', zoneId: 'original-zone' }, 'object.zone']
] as const)('themes the actual %s link by object identity and still opens its exact original URI', async (kind, target, id) => {
  const uri = `amux://${kind}/original-identity`, open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  await dom.render(<InlineObjectLink uri={uri} target={target as ObjectLinkReference['target']} label="Original retained target" />)
  const button = dom.container.querySelector('[data-object-link-open]')!
  drawing(button, id)
  const theme = structuredClone(GRAPHITE_THEME); theme.id = 'custom.caller-object'; theme.name = 'Only this object'
  theme.icons = { [id]: { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } }
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  expect(document.getElementById(semanticIconHref(id).slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(dom.container.querySelector('[data-object-link-open]')).toBe(button)
  await click(button)
  expect(open).toHaveBeenCalledExactlyOnceWith(uri)
})

it('separates real topology, Topic, Tab and Region objects without changing their original Session projection', async () => {
  const session = composerSession('original-topology'), tab = { ...createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: session.id }), topicId: 'original-topic' }
  await dom.render(<AgentTopologySummary sessionIds={[session.id]} sessions={[session]} tabs={{ [tab.id]: tab }} config={useAppStore.getState().config} />)
  drawing(dom.container.querySelector('.agent-topology-summary__header')!, 'object.topology')
  drawing(dom.container.querySelector('.agent-topology-summary__topic-line')!, 'object.topic')
  drawing(dom.container.querySelector('.agent-topology-summary__tab-line')!, 'object.tab')
  drawing(dom.container.querySelector('[data-region-id="original-region"]')!, 'object.region')
  expect(dom.container.querySelector('[data-semantic-icon="layout.split-vertical"]')).toBeNull()
  expect(dom.container.querySelector('[data-tab-id]')?.getAttribute('data-tab-id')).toBe(tab.id)
  expect(dom.container.textContent).toContain('original-topic')
  expect(session.control.agentSessionId).toBe('original-topology')
})

it('the table-header control still interprets the exact original first row and retains the data rows', async () => {
  const content = 'Name,Value\nOriginal,7\nRetained,9'
  await dom.render(<FileDataPreview content={content} kind="csv" />)
  const header = [...dom.container.querySelectorAll('button')].find(node => node.textContent === 'Header row')!
  drawing(header, 'control.table-header')
  expect(header.getAttribute('aria-pressed')).toBe('true')
  expect(dom.container.querySelector('thead')?.textContent).toContain('Name')
  await click(header)
  expect(header.getAttribute('aria-pressed')).toBe('false')
  expect(dom.container.querySelector('thead')?.textContent).toContain('Column 1')
  expect(dom.container.querySelector('tbody')?.textContent).toContain('NameValue')
  expect(dom.container.textContent).toContain('Original7')
  expect(dom.container.textContent).toContain('Retained9')
})

it('idle Focus uses the original observation instead of claiming the Agent was paused', async () => {
  const now = Date.now(), session = composerSession('idle-original')
  session.status = { state: 'done', source: 'native-hook', observedAt: now }
  session.semanticStatus = session.status
  const state = useAppStore.getState(), contexts = createFocusProjectionSelector()({ sessions: [session], config: state.config, timelines: {}, agentNames: {}, scratchTopicSnapshots: {} }).contexts
  expect(contexts).toHaveLength(1); expect(contexts[0]!.bucket).toBe('idle')
  await dom.render(<FocusContextStateMark context={contexts[0]!} />)
  drawing(dom.container, 'status.idle')
  expect(dom.container.querySelector('[data-icon-animation]')).toBeNull()
  expect(session.processState).toBe('running')
  await dom.render(<FocusContextStateMark context={{ ...contexts[0]!, activitySemantic: 'unknown' }} />)
  drawing(dom.container, 'status.unknown')
})

it('unknown executor remains unknown while the original launch prompt and actions remain available', async () => {
  const action = vi.fn()
  await dom.render(<SessionConnectingSurface phase="launch" surfaceKind="agent" request={{ executorId: 'original-unconfirmed-executor', prompt: 'Original prompt retained' } as never} actions={<button onClick={action}>Original recovery action</button>} />)
  drawing(dom.container.querySelector('.session-connecting__executor')!, 'status.executor-unknown')
  expect(dom.container.textContent).toContain('original-unconfirmed-executor')
  expect(dom.container.textContent).toContain('Original prompt retained')
  await click([...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Original recovery action')!)
  expect(action).toHaveBeenCalledOnce()
})

it('typed recovery presentation keeps checking and Session restore distinct without changing the original action', async () => {
  const source = { hostId: 'local', agentSessionId: 'same-session', workspaceId: 'workspace', tabId: 'same-tab', regionId: 'same-region', displayWorkspaceId: 'workspace', groupId: 'same-group', diagnostic: 'Original operation unconfirmed' }, restore = vi.fn()
  await dom.render(<SessionRecoveryActions source={source} restoring={false} restoreIcon="action.refresh" restoreLabel="Original owner check" onRestore={restore} />)
  const button = dom.container.querySelector('button')!
  drawing(button, 'action.refresh')
  await click(button); expect(restore).toHaveBeenCalledOnce()
  await dom.render(<SessionRecoveryActions source={source} restoring={false} restoreLabel="Same arbitrary copy" onRestore={restore} />)
  drawing(dom.container.querySelector('button')!, 'action.resume-session')
  expect(restore).toHaveBeenCalledOnce()
})

it('browser waiting, return-control and replay retain their exact original control callbacks', async () => {
  const operation: BrowserOperation = { id: 'same-operation', browserId: 'same-browser', operator: { id: 'same-session', name: 'Original Agent' }, startedAt: _historyFixtureEpoch(0, 0, 1), phase: 'waiting', summary: 'Original operation', url: 'https://example.test/original', steps: [] }, returned = vi.fn()
  await dom.render(<BrowserOperationStatus activity={{ control: 'agent', operation }} onReturnControl={returned} />)
  drawing(dom.container.querySelector('.browser-operation-status__trigger')!, 'status.waiting')
  await dom.render(<BrowserOperationStatus activity={{ control: 'human', operation }} onReturnControl={returned} />)
  await act(async () => dom.container.querySelector('.browser-operation-status__trigger')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === 'Return to Agent')!
  drawing(item, 'action.return-control'); await click(item); expect(returned).toHaveBeenCalledOnce()
  const plan: BrowserReplayPlan = { schema: 'agentmux.browser-replay.v1', operationId: operation.id, url: operation.url, steps: [] }
  await dom.render(<BrowserReplayPreview plan={plan} busy={false} />)
  drawing(dom.container.querySelector('.browser-rsi-replay__header')!, 'action.replay')
})

it('permission rejection remains the original typed rejection and never becomes cancellation', async () => {
  const respond = vi.fn().mockResolvedValue(undefined)
  const request = { kind: 'permission' as const, id: 'same-permission', agentSessionId: 'same-session', title: 'Original tool request', toolName: 'Original tool', options: [{ id: 'same-allow', label: 'Allow original', kind: 'allow-once' as const }, { id: 'same-reject', label: 'Reject original', kind: 'reject-once' as const }], evidence: { source: 'native-hook' as const, observedAt: _historyFixtureEpoch(0, 0, 1), run: { runId: 'same-run' }, hookReceiptId: 'same-permission' } }
  await dom.render(<AgentInteractionCard request={request} onRespond={respond} />)
  const reject = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Reject original')!
  drawing(reject, 'action.reject')
  await click(reject)
  expect(respond).toHaveBeenCalledOnce()
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ kind: 'permission', decision: { outcome: 'selected', optionId: 'same-reject' } })
  expect(respond.mock.calls[0]?.[1]).toMatchObject({ expectedRequest: expect.objectContaining({ id: request.id, agentSessionId: request.agentSessionId }) })
})

it('the real composer mode and quick-reply motif follow their original finite choices', async () => {
  const change = vi.fn()
  for (const [phase, id, next] of [['collapsed', 'object.composer-details', 'current'], ['current', 'layout.composer-grow', 'expanded'], ['expanded', 'layout.composer-collapse', 'collapsed']] as const) {
    await dom.render(<><ComposerLayoutToggle phase={phase} onChange={change} /><PromptReactionIconView icon="message-circle" /></>)
    drawing(dom.container.querySelector('button')!, id)
    drawing(dom.container, 'object.conversation')
    await click(dom.container.querySelector('button'))
    expect(change).toHaveBeenLastCalledWith(next)
  }
  expect(change).toHaveBeenCalledTimes(3)
})
