// @vitest-environment happy-dom
import { act } from 'react'
import type { Window as HappyDOMWindow } from 'happy-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { AgentCollaborationGraph } from '../src/renderer/src/components/AgentCollaborationGraph'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, collaborationSubjectKey } from '../src/renderer/src/lib/agent-collaboration'
import { COLLABORATION_ACTIVITY_MS } from '../src/renderer/src/lib/collaboration-map-presentation'
import { COLLABORATION_TRANSFER_MS } from '../src/renderer/src/components/CollaborationDispatchSignal'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import baseCSS from '../src/renderer/src/styles/base.css?inline'
import collaborationCSS from '../src/renderer/src/styles/collaboration.css?inline'

const dom = composerDOM({ agentInformation: true })
const browser = window as unknown as HappyDOMWindow
let stylesheet: HTMLStyleElement
beforeEach(() => {
  installCollaborationCanvasGeometry()
  installCollaborationLayoutLoopback()
  browser.happyDOM.settings.device.prefersReducedMotion = 'reduce'
  stylesheet = document.createElement('style')
  // Both real sheets participate, including the global important reduction rule.
  stylesheet.textContent = collaborationCSS + '\n' + baseCSS
  document.head.append(stylesheet)
})
afterEach(() => {
  stylesheet.remove()
  browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference'
})
const duration = (element: Element) => {
  const value = getComputedStyle(element).animationDuration
  return Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)
}

it('honors explicit map motion through the actual reduced-motion cascade without restoring unrelated animations', async () => {
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
  const contexts = ['source', 'recipient'].map(id => agentContextForSession(composerSession(id), undefined, id, undefined, null))
  const agents = collaborationAgents(contexts)
  const members = contexts.map(context => collaborationSubjectKey({ hostId: 'local', agentSessionId: context.id }))
  let config = useAppStore.getState().config!
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    config = applyConfigEdit(config, expected, next); useAppStore.setState({ config }); return config
  })
  await dom.render(<AgentCollaborationGraph agents={agents} areas={[{ id: 'original-project', kind: 'project', name: 'Original project', members }]}
    relations={[{ id: 'original-message', kind: 'communication', source: members[0]!, target: members[1]!, evidence: [] }]}
    pulses={[{ id: 1, startedAt: Date.now() - 400, hostId: 'local', sender: 'source', recipient: 'recipient', kind: 'communication' }]}
    selection={null} onSelect={vi.fn()} onOpen={vi.fn()} />)
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-activity')).not.toBeNull())
  expect(dom.container.querySelector('[aria-label="Map animations"]')?.getAttribute('aria-pressed')).toBe('false')
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(duration(dom.container.querySelector('.collaboration-activity')!)).toBe(0)

  await dom.click('[aria-label="Map animations"]')
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-edge__packet')).not.toBeNull())
  expect(config.focus?.mapMotion).toBe('on')
  expect(duration(dom.container.querySelector('.collaboration-activity')!)).toBe(COLLABORATION_ACTIVITY_MS)
  for (const selector of ['.collaboration-edge__pulse', '.collaboration-edge__packet']) {
    expect(duration(dom.container.querySelector(selector)!)).toBe(COLLABORATION_TRANSFER_MS)
  }
  expect(getComputedStyle(dom.container.querySelector('.collaboration-edge')!).transitionDuration).toBe('150ms')
  expect(duration(dom.container.querySelector('.collaboration-canvas__controls')!)).toBe(0)
  expect(duration(document.body)).toBe(0)
  // Stylesheet order must not defeat the explicit choice either.
  await act(async () => { stylesheet.textContent = baseCSS + '\n' + collaborationCSS })
  expect(duration(dom.container.querySelector('.collaboration-edge__packet')!)).toBe(COLLABORATION_TRANSFER_MS)
  expect(getComputedStyle(dom.container.querySelector('.collaboration-edge')!).transitionDuration).toBe('150ms')

  await dom.click('[aria-label="Map animations"]')
  expect(config.focus?.mapMotion).toBe('off')
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(dom.container.querySelector('.collaboration-edge__pulse')).toBeNull()
  expect(duration(dom.container.querySelector('.collaboration-activity')!)).toBe(0)
})

it('keeps original territory title geometry and controls without colored frames in the actual cascade', async () => {
  const contexts = ['project-member', 'topic-member', 'mote-member'].map(id => agentContextForSession(composerSession(id), undefined, id, undefined, null))
  const agents = collaborationAgents(contexts)
  const areas = (['project', 'topic', 'mote'] as const).map((kind, index) => ({ id: `original-${kind}`, kind,
    name: `Original ${kind}`, members: [collaborationSubjectKey({ hostId: 'local', agentSessionId: contexts[index]!.id })] }))
  await dom.render(<AgentCollaborationGraph agents={agents} areas={areas} relations={[]} pulses={[]}
    selection={null} onSelect={vi.fn()} onOpen={vi.fn()} />)
  await settleCollaborationCanvas(() => expect(dom.container.querySelectorAll('.collaboration-area__overview-label')).toHaveLength(3))
  for (const area of areas) {
    const title = dom.container.querySelector<HTMLElement>(`[data-region-id="${area.id}"]`)!
    const name = title.querySelector('strong')!
    const summary = title.querySelector<HTMLButtonElement>('.collaboration-area__summary')!
    expect(name.textContent).toBe(area.name)
    expect(getComputedStyle(name).fontSize).toBe('12px')
    expect(getComputedStyle(name).fontWeight).toBe('600')
    expect(getComputedStyle(summary).minHeight).toBe('44px')
    expect(getComputedStyle(summary).padding).toBe('6px 26px 6px 11px')
    expect(summary.getAttribute('aria-label')).toBe(`Locate ${area.name} · 1 Agents`)
    expect(title.querySelector(`[aria-label="Collapse ${area.name}"]`)?.getAttribute('aria-expanded')).toBe('true')
    for (const order of [collaborationCSS + '\n' + baseCSS, baseCSS + '\n' + collaborationCSS]) {
      await act(async () => { stylesheet.textContent = order })
      const before = getComputedStyle(title)
      expect(before.borderTopWidth).toBe('1px')
      expect(before.borderLeftWidth).toBe('1px')
      expect(before.borderTopColor).toBe('transparent')
      expect(before.boxShadow).toBe('none')
    }
    await dom.click(`[aria-label="Locate ${area.name} · 1 Agents"]`)
    await settleCollaborationCanvas(() => expect(title.dataset.current).toBe('true'))
    expect(getComputedStyle(title).borderTopColor).toBe('transparent')
    expect(getComputedStyle(title).boxShadow).toBe('none')
    expect(title.querySelector('strong')).toBe(name)
    expect(title.querySelector('.collaboration-area__summary')).toBe(summary)
  }
})
