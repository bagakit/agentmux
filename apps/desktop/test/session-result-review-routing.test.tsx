// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAgentTimelineMutation } from '@agentmux/core/timeline'
import { conversationRevision } from '@agentmux/core/conversation'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/ActivityView.js', () => ({ ActivityView: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))

import { SessionPane } from '../src/renderer/src/components/SessionPane.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'

const session = {
  ...composerSession('mounted-result'), label: 'Mounted result', updatedAt: 2, processState: 'exited' as const,
  status: { state: 'done' as const, source: 'native-hook' as const, observedAt: 2 }
}
const origin = { workspaceId: 'workspace', tabGroupId: 'original-review-group' }

function previewItem(target: typeof session, label: string, ordinal: number) {
  return { id: `preview-${ordinal}`, agentSessionId: target.id, kind: 'assistant_message' as const,
    source: 'native-hook' as const, status: 'complete' as const, title: 'Original result',
    content: `Preview https://${label}.example.test/`, createdAt: ordinal, updatedAt: ordinal }
}

async function publishPreview(target: typeof session, label: string, ordinal: number) {
  const item = previewItem(target, label, ordinal)
  const mutation = { type: 'append' as const, agentSessionId: target.id, item }
  const [normalized] = applyAgentTimelineMutation([], mutation)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: target.hostId, event: {
    type: 'agent-timeline', agentSessionId: target.id, sourceHostId: target.hostId, revision: ordinal, mutation,
    stream: { epoch: 'review-timeline', revision: ordinal, sequence: ordinal, origin: 'beginning', gaps: [] },
    position: { id: item.id, firstSequence: ordinal, sequence: ordinal, revision: conversationRevision(normalized!) },
    evidence: { source: 'native-hook', observedAt: target.updatedAt, run: target.control.run }
  } }))
  expect(useAppStore.getState().timelines[target.id]?.revision).toBe(ordinal)
}

describe('SessionResultReview production routing', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    useAppStore.setState({ sessions: [session], timelines: {}, config: composerConfig,
      agentComposerDrafts: { [session.id]: 'Keep my original draft' },
      viewModes: { [session.id]: 'terminal' }, recoveryCandidates: [], pendingAgentLaunches: {} })
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true) })

  it('mounts the result control in the existing composer through SessionPane', async () => {
    await act(async () => root.render(createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent', interactiveResize: false, visible: true, linkOrigin: origin })))
    expect(container.querySelector('.composer .session-result-review')).toBeNull()
    expect(container.querySelector('.session-result-review-slot')).toBeNull()
    const avatar = container.querySelector<HTMLButtonElement>('.composer-agent-identity .agent-avatar')!
    await act(async () => avatar.click())
    const face = document.getElementById(avatar.getAttribute('aria-controls')!)!
    expect(face.querySelector('.session-result-review__details')).toBeNull()
    const review = face.querySelector<HTMLButtonElement>('.agent-state-face__review')!
    expect(review.textContent).toContain('Review result')
    await act(async () => review.click())
    expect([...face.querySelectorAll('.session-result-review__details-actions button')].map((button) => button.textContent?.trim())).toEqual(['Activity', 'Continue in Session'])
    expect(face.querySelector('[popover]')).toBeNull()

  })

  it('keeps a read-only result control in the existing Region header', async () => {
    await act(async () => root.render(createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent', interactiveResize: false, visible: true, readOnly: true, linkOrigin: origin })))
    expect(container.querySelector('.agent-region-header .session-result-review__trigger')).toBeTruthy()
    expect(container.querySelector('.agent-input-stack')).toBeNull()
  })

  it.each([false, true])('owns the current timeline only within opened result details (readOnly = %s)', async readOnly => {
    const neighborIdentity = composerSession('neighbor-result')
    const neighbor = { ...session, id: neighborIdentity.id, control: neighborIdentity.control }
    const openHttpLink = vi.fn(async () => {})
    useAppStore.setState({ sessions: [session, neighbor], openHttpLink })
    const render = (visible: boolean) => act(async () => root.render(createElement(SessionPane, {
      sessionId: session.id, surfaceKind: 'agent', interactiveResize: false, visible, readOnly, linkOrigin: origin
    })))
    await render(true)
    const editor = readOnly ? null : container.querySelector('.ProseMirror')
    if (!readOnly) expect(editor).not.toBeNull()
    await render(false)
    const before = rendererPerformance.snapshot().consumers
    await publishPreview(session, 'original-before-opening', 1)
    await publishPreview(neighbor, 'unrelated-result', 1)
    const after = rendererPerformance.snapshot().consumers
    expect(after.sessionPane.hidden.commits).toBe(before.sessionPane.hidden.commits)
    expect(after.composer.hidden.commits).toBe(before.composer.hidden.commits)
    expect(container.querySelector('.session-result-review__details')).toBeNull()
    expect(useAppStore.getState().sessions[0]).toBe(session)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep my original draft')
    await render(true)
    expect(container.querySelector('.ProseMirror')).toBe(editor)
    let surface: HTMLElement = container
    if (readOnly) {
      await act(async () => container.querySelector<HTMLButtonElement>('.session-result-review__trigger')!.click())
    } else {
      const avatar = container.querySelector<HTMLButtonElement>('.composer-agent-identity .agent-avatar')!
      await act(async () => avatar.click())
      surface = document.getElementById(avatar.getAttribute('aria-controls')!)!
      await act(async () => surface.querySelector<HTMLButtonElement>('.agent-state-face__review')!.click())
    }
    const previews = () => [...surface.querySelectorAll<HTMLButtonElement>('.session-result-review__details-actions button')]
      .map(button => button.querySelector<HTMLSpanElement>('span[title]')?.title).filter(Boolean)
    expect(previews()).toEqual(['https://original-before-opening.example.test/'])
    await publishPreview(session, 'original-while-open', 2)
    expect(previews()).toEqual(['https://original-while-open.example.test/', 'https://original-before-opening.example.test/'])
    const timeline = useAppStore.getState().timelines[session.id]!
    // Preview publishes a revision while retaining the in-place array and original Session.
    await act(async () => {
      timeline.items.push(previewItem(session, 'preview-in-place', 3))
      timeline.revision++
      useAppStore.setState(state => ({ timelines: { ...state.timelines } }))
    })
    expect(previews()).toEqual(['https://preview-in-place.example.test/', 'https://original-while-open.example.test/',
      'https://original-before-opening.example.test/'])
    const preview = surface.querySelector<HTMLSpanElement>('[title="https://original-while-open.example.test/"]')!.closest('button')!
    await act(async () => preview.click())
    expect(openHttpLink).toHaveBeenCalledExactlyOnceWith(origin, 'https://original-while-open.example.test/', 'tab')
    expect(useAppStore.getState().sessions[0]?.control).toBe(session.control)
  })
})
