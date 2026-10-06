// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { RecordedAgentRow, RecordedStepsCard, RecordedToolRow } from '@agentmux/client-ui/components/WorkflowObservation'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ResolvedAgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { BrowserOperationStatus } from '../src/renderer/src/components/BrowserOperationSurface'
import { FocusTimelineEventPreview } from '../src/renderer/src/components/FocusTimelineEventPreview'
import { WorkspaceBoard } from '../src/renderer/src/components/WorkspaceBoard'
import { BoardRowsProvider } from '../src/renderer/src/hooks/useBoardRows'
import { focusWorkingFacts } from '../src/renderer/src/lib/focus-timeline-event-facts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { BrowserActivityState } from '../src/shared/browser-operation'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { fixture as mobileFixture, history } from '../../mobile/test/conversation-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let releaseTheme: () => void
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  releaseTheme = mountThemeRuntime(window)
})
afterEach(() => { releaseTheme(); vi.unstubAllGlobals() })

const roles = ['status.working', 'status.streaming', 'status.browser-running', 'object.activity', 'status.loading'] as const
const drawings = Object.fromEntries(roles.map((role, index) => [role, `M${index + 2} 3H20V${index + 14}H${index + 2}Z`]))
async function customize(names: readonly SemanticIconId[] = roles) {
  const theme = structuredClone(GRAPHITE_THEME)
  theme.id = 'custom.activity-meanings'; theme.name = 'Independent activity meanings'
  theme.icons = Object.fromEntries(names.map(name => [name, { kind: 'paths', paths: [{ d: drawings[name] }] }]))
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  for (const name of names) expect(document.getElementById(semanticIconHref(name).slice(1))?.querySelector('path')?.getAttribute('d')).toBe(drawings[name])
}
function glyph(scope: ParentNode | null, name: SemanticIconId, size: number) {
  expect(scope, `Actual nonempty consumer of ${name}`).not.toBeNull()
  const svg = scope!.querySelector<SVGSVGElement>('svg')
  expect(svg, `Actual drawing of ${name}`).not.toBeNull()
  expect(svg!.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(name))
  expect(svg!.getAttribute('width')).toBe(String(size))
  const symbol = document.getElementById(semanticIconHref(name).slice(1))
  expect(symbol?.children.length, `Nonempty drawing bank entry for ${name}`).toBeGreaterThan(0)
  return svg!
}
const captured = (agentSessionId = 'agent-1'): AgentTimelineItem => ({
  id: 'original-streaming-reply', agentSessionId, kind: 'assistant_message', source: 'native-hook',
  status: 'streaming', title: 'Reply', content: 'Original partial reply', createdAt: _newTailFixtureEpoch(0, 0, 10), updatedAt: _newTailFixtureEpoch(0, 0, 11)
})

it('Desktop Activity keeps captured Streaming separate from current Agent work and preserves the original record and draft', async () => {
  const item = captured(), original = structuredClone(item)
  const session = composerSession(); session.status = { state: 'working', source: 'native-hook', observedAt: _newTailFixtureEpoch(0, 0, 11) }
  useAppStore.setState({ sessions: [session] })
  const render = (items = [item]) => dom.render(<>
    <ActivityView sessionId="agent-1" items={items} capability="complete-events" displayState="working" />
    <ResolvedAgentAvatar label="Original working Agent" providerId="codex" state="working" />
  </>)
  await render()
  const message = dom.container.querySelector<HTMLElement>('[data-message-id="original-streaming-reply"]')!
  const chip = message.querySelector<HTMLElement>('.log-row__chip[role="status"]')!
  const stream = glyph(chip, 'status.streaming', 12)
  const work = glyph(dom.container.querySelector('.agent-avatar__status--working'), 'status.working', 10)
  const sourceRef = message.dataset.conversationItemRef
  expect(message.dataset.status).toBe('streaming'); expect(message.textContent).toContain(item.content)
  const unchanged = roles.filter(name => name !== 'status.streaming').map(name => [name,
    document.getElementById(semanticIconHref(name).slice(1))!.innerHTML] as const)
  await customize(['status.streaming'])
  expect(dom.container.querySelector('[data-message-id="original-streaming-reply"]')).toBe(message)
  expect(chip.querySelector('svg')).toBe(stream); expect(work.isConnected).toBe(true)
  for (const [name, drawing] of unchanged) expect(document.getElementById(semanticIconHref(name).slice(1))?.innerHTML).toBe(drawing)
  expect(message.dataset.conversationItemRef).toBe(sourceRef)
  expect(item).toEqual(original); expect(useAppStore.getState().sessions[0]).toBe(session)
  expect(dom.draft()).toBe('Keep my draft')
  await render([{ ...item, status: 'complete' }])
  expect(dom.container.querySelector('[data-message-id="original-streaming-reply"]')).toBe(message)
  expect(message.querySelector('.log-row__chip[role="status"]')).toBeNull()
  expect(message.textContent).toContain('Original partial reply'); expect(item.status).toBe('streaming')
})

it('the actual Mobile surface and browser platform share Streaming without changing the original hosted Session, Run or input capability', async () => {
  const f = mobileFixture(), item = captured('session-original'), session = f.sessions.get('session-original')!
  f.setPage({ ...history(), items: [], nextCursor: null })
  f.setTimeline({ agentSessionId: 'session-original', revision: 2, items: [item] })
  await dom.render(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: 'Connected' }} platform={createBrowserPlatform()} />)
  const message = dom.container.querySelector<HTMLElement>('.mobile-conversation__captured [data-message-id="original-streaming-reply"]')!
  const chip = message?.querySelector<HTMLElement>('.log-row__chip[role="status"]')!
  const stream = glyph(chip, 'status.streaming', 12)
  const input = dom.container.querySelector('[contenteditable="true"]')
  expect(input).not.toBeNull(); expect(message.dataset.status).toBe('streaming')
  const sourceRef = message.dataset.conversationItemRef
  await customize()
  expect(dom.container.querySelector('[data-message-id="original-streaming-reply"]')).toBe(message)
  expect(chip.querySelector('svg')).toBe(stream); expect(message.dataset.conversationItemRef).toBe(sourceRef)
  expect(message.textContent).toContain('Original partial reply')
  expect(dom.container.querySelector('[contenteditable="true"]')).toBe(input)
  expect(f.client.agentSession('session-original')).toBe(session)
  expect(session.run.runId).toBe('run-original'); expect(f.submit).not.toHaveBeenCalled()
})

it('shared captured messages and observed Streaming chips/counts use the stream role while recorded running remains its recorded status', async () => {
  const item = captured(), onToggle = vi.fn()
  function Observations() {
    const [expanded, setExpanded] = useState(false)
    return <><CapturedConversationMessage item={item} speaker={{ role: 'agent', id: 'agent-1' }} name="Original Agent" />
      <RecordedStepsCard observation={{ id: 'original-observation', stepCount: 2, status: 'running', streaming: true,
        counts: { complete: 0, streaming: 2, failed: 0, unknown: 0 } }} expanded={expanded} onExpandedChange={setExpanded}>
        <p>Original retained observation body</p>
      </RecordedStepsCard>
      <RecordedToolRow observation={{ id: 'original-tool', title: 'Original operation', status: 'streaming', source: 'Native record', persistentSource: true }}
        className="fixture-tool" icon={<span>Tool</span>} expanded={false} onToggle={onToggle} controls="original-tool-details" />
      <ul><RecordedAgentRow observation={{ id: 'original-child', label: 'Original child Agent', source: 'native-child', state: 'running' }} /></ul>
    </>
  }
  await dom.render(<Observations />)
  const scopes = [dom.container.querySelector('.log-turn .log-row__chip[role="status"]'),
    [...dom.container.querySelectorAll('.wf-chip')].find(node => node.textContent === 'Streaming')!,
    dom.container.querySelector('[data-state="streaming"]'), dom.container.querySelector('.fixture-tool .log-row__chip')]
  expect(scopes).toHaveLength(4)
  const streams = scopes.map(node => glyph(node, 'status.streaming', 12))
  const recorded = [...dom.container.querySelectorAll('.wf-chip')].find(node => node.textContent === 'Recorded running')!
  const running = glyph(recorded, 'status.running', 12)
  glyph(dom.container.querySelector('.wf-agent__state'), 'status.running', 12)
  const card = dom.container.querySelector('[data-observation-id="original-observation"]')!
  const fold = card.querySelector<HTMLButtonElement>('.wf-head')!
  const controls = fold.getAttribute('aria-controls')!
  const tool = dom.container.querySelector<HTMLButtonElement>('[data-observation-step-id="original-tool"]')!
  await customize()
  scopes.forEach((node, index) => expect(node!.querySelector('svg')).toBe(streams[index]))
  expect(recorded.querySelector('svg')).toBe(running); expect(card.getAttribute('data-status')).toBe('running')
  expect(tool.getAttribute('data-status')).toBe('streaming'); expect(tool.getAttribute('aria-controls')).toBe('original-tool-details')
  await act(async () => { fold.click(); tool.click() })
  expect(fold.getAttribute('aria-expanded')).toBe('true'); expect(fold.getAttribute('aria-controls')).toBe(controls)
  expect(document.getElementById(controls)?.textContent).toContain('Original retained observation body')
  expect(onToggle).toHaveBeenCalledOnce(); expect(item.status).toBe('streaming')
})

it('Browser running has its own role and keeps exact operation, control, semantic target and stop action through an override', async () => {
  const activity: BrowserActivityState = { control: 'agent', operation: {
    id: 'original-operation', browserId: 'original-browser', operator: { id: 'agent-1', name: 'Navigator', providerId: 'codex' },
    startedAt: _newTailFixtureEpoch(0, 0, 1), phase: 'running', summary: 'Inspect settings', url: 'https://example.test/settings',
    steps: [{ sequence: 1, method: 'click', label: 'Open settings', startedAt: _newTailFixtureEpoch(0, 0, 2), status: 'running',
      target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 } }]
  } }
  const original = structuredClone(activity), stop = vi.fn(), take = vi.fn()
  await dom.render(<BrowserOperationStatus activity={activity} onTakeControl={take} onStop={stop} />)
  const status = dom.container.querySelector<HTMLElement>('.browser-operation-status')!
  const trigger = status.querySelector<HTMLButtonElement>('button')!, icon = glyph(trigger, 'status.browser-running', 13)
  const label = trigger.getAttribute('aria-label')
  expect(label).toContain('Navigator'); expect(label).toContain('button “Open settings”')
  await customize()
  expect(dom.container.querySelector('.browser-operation-status')).toBe(status)
  expect(status.querySelector('button')).toBe(trigger); expect(trigger.querySelector('svg')).toBe(icon)
  expect(trigger.getAttribute('aria-label')).toBe(label)
  expect(status.dataset).toMatchObject({ phase: 'running', control: 'agent', operationId: 'original-operation' })
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const stopItem = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Stop browser operation"]')
  expect(stopItem).not.toBeNull()
  await act(async () => stopItem!.click())
  expect(stop).toHaveBeenCalledOnce(); expect(take).not.toHaveBeenCalled(); expect(activity).toEqual(original)
})

it('real Board work and historical Working observations remain distinct meanings with retained rows and source facts', async () => {
  const session = composerSession(); session.label = 'Original board Agent'; session.status = { state: 'working', source: 'native-hook', observedAt: _newTailFixtureEpoch(0, 0, 11) }
  useAppStore.setState({ sessions: [session], activeWorkspaceId: 'workspace' })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'local',
    repoPath: composerConfig.workspaces[0]!.path, branches: [{ name: 'original-branch', workspaceId: 'workspace', worktreePath: session.workspacePath, isCurrent: true }] })
  const facts = focusWorkingFacts({ startAt: _newTailFixtureEpoch(0, 0, 1), startKnown: true, endAt: _newTailFixtureEpoch(0, 0, 1001), end: 'run-ended' },
    { detailed: value => `Original timestamp ${value}` } as Parameters<typeof focusWorkingFacts>[1], undefined, undefined, _newTailFixtureEpoch(0, 0, 2001))
  const originalFacts = structuredClone(facts), anchorHost = document.createElement('section'), anchor = document.createElement('button')
  anchorHost.className = 'recent-focus'; anchorHost.innerHTML = '<header class="recent-focus__header">Original history</header>'
  anchorHost.append(anchor); document.body.append(anchorHost)
  const close = vi.fn()
  try {
    await dom.render(<><BoardRowsProvider enabled><WorkspaceBoard /></BoardRowsProvider>
      <FocusTimelineEventPreview facts={facts} anchor={anchor} onClose={close} onMouseEnter={() => {}} onMouseLeave={() => {}} /></>)
    const head = dom.container.querySelector('.board-column-head--working')!, work = glyph(head, 'status.working', 13)
    const row = dom.container.querySelector('[data-board-row="original-branch"]')!
    expect(row).not.toBeNull(); expect(row.querySelector('.board-cell--working')?.textContent).toContain('Original board Agent')
    glyph(row.querySelector('.agent-avatar__status--working'), 'status.working', 10)
    const preview = document.querySelector<HTMLElement>('.recent-focus__event-preview[data-event-kind="work"]')!
    const historyIcon = glyph(preview.querySelector('header'), 'object.activity', 14)
    expect(preview.textContent).toContain('Working observation'); expect(preview.textContent).toContain('Run ended')
    const describedBy = anchor.getAttribute('aria-describedby')
    await customize()
    expect(dom.container.querySelector('.board-column-head--working')).toBe(head); expect(head.querySelector('svg')).toBe(work)
    expect(dom.container.querySelector('[data-board-row="original-branch"]')).toBe(row)
    expect(preview.querySelector('header svg')).toBe(historyIcon); expect(anchor.getAttribute('aria-describedby')).toBe(describedBy)
    expect(facts).toEqual(originalFacts); expect(session.status.state).toBe('working'); expect(dom.draft()).toBe('Keep my draft')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(close).toHaveBeenCalledOnce()
  } finally { anchorHost.remove() }
})

it('real Activity Reading uses loading while retaining the existing message/feed and its read action target', async () => {
  const item = { ...captured(), status: 'complete' as const }, earlier = vi.fn()
  const read = { loading: true, error: null, hasMore: true, onRetry: vi.fn(), onReadEarlier: earlier }
  const render = (loading: boolean) => dom.render(<ActivityView sessionId="agent-1" items={[item]} capability="complete-events" userMessageRead={{ ...read, loading }} />)
  await render(true)
  const feed = dom.container.querySelector('.activity-feed')!, message = feed.querySelector('[data-message-id="original-streaming-reply"]')!
  const loading = dom.container.querySelector('.activity-feed__loading-layer [role="status"]')!, icon = glyph(loading, 'status.loading', 12)
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Read earlier records')!
  expect(button).toBeDefined(); expect(loading.textContent).toContain('Reading records…')
  expect(loading.querySelector('.semantic-icon--working')).toBeNull()
  await customize()
  expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(feed.querySelector('[data-message-id="original-streaming-reply"]')).toBe(message)
  expect(loading.querySelector('svg')).toBe(icon); expect(message.textContent).toContain(item.content)
  await act(async () => button.click())
  expect(earlier).toHaveBeenCalledExactlyOnceWith(button)
  await render(false)
  expect(dom.container.querySelector('.activity-feed__loading-layer')).toBeNull()
  expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(message.isConnected).toBe(true)
  expect(item.status).toBe('complete'); expect(dom.draft()).toBe('Keep my draft')
})
