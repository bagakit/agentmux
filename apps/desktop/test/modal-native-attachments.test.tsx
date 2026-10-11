// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { DocumentOverlayPortal } from '../src/renderer/src/components/WindowOverlayHost'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { ServiceNoticeDisclosure } from '../src/renderer/src/components/ServiceNoticeDisclosure'
import { SessionResultReview } from '../src/renderer/src/components/SessionResultReview'
import { Ruler } from '../src/renderer/src/components/ConversationRuler'
import { createRulerScale } from '../src/renderer/src/lib/activity-ruler'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover } from './fixtures/mote-workface'

vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({ status: null, loading: false, error: null, refresh: vi.fn() }) }))
const dom = composerDOM(), session = { ...composerSession('modal-result'), processState: 'exited' as const,
  status: { state: 'done' as const, source: 'run-process' as const, observedAt: _tailFixtureEpoch(0, 0, 1) } }
const cases: { name: string; selector: string; content(): ReactNode }[] = [
  { name: 'Context', selector: '.composer__context-card', content: () => <AgentContextUsage /> },
  { name: 'System notifications', selector: '.global-system-notices__details', content: () => <GlobalSystemNotices /> },
  { name: 'Mailbox', selector: '.composer-mailbox', content: () => <SessionMailbox system={{ notices: [], unread: [], acknowledge() {}, available: true } as never} queued={[]} /> },
  { name: 'Service details', selector: '.service-disclosure__details', content: () => <ServiceNoticeDisclosure scope="modal-service" notices={[{ id: 'original', notice: { kind: 'indeterminate', notice: { step: 'Original read', mode: 'Observation unavailable', restore: 'Read again' } } }]}><p>Original service facts</p></ServiceNoticeDisclosure> },
  { name: 'Result review', selector: '.session-result-review__popover', content: () => <SessionResultReview sessionId={session.id} items={[]} origin={{ workspaceId: 'workspace' }} visible surfaceAnchor="--original-surface" /> },
  { name: 'Timeline guide', selector: '.activity-ruler__guide', content: () => <Ruler items={[]} scale={createRulerScale([], 100)} band={null} selectedIndex={null} onSelect={() => {}} /> }
]
let restorePopover: () => void
beforeEach(() => { restorePopover = installNativePopover(); useAppStore.setState({ sessions: [session] }) })
afterEach(async () => { await dom.render(null); restorePopover() })

async function scene(open: boolean, content: ReactNode, onOpenChange = vi.fn()) {
  await dom.render(<Modal.Root open={open} onOpenChange={onOpenChange}>
    <DocumentOverlayPortal component={Modal.Portal} forceMount>
      <Modal.Overlay className="dialog-scrim" />
      <Modal.Content className="dialog-surface" aria-describedby={undefined}>
        <Modal.Title>Original modal</Modal.Title><input defaultValue="Original unsent draft" />{content}
      </Modal.Content>
    </DocumentOverlayPortal>
  </Modal.Root>)
}

it.each(cases)('$name owns one Escape before its source modal', async ({ content, selector }) => {
  const parentOpenChange = vi.fn(); await scene(true, content(), parentOpenChange)
  const surface = document.querySelector<HTMLElement>(selector)!, original = document.querySelector<HTMLElement>('.dialog-surface')!
  const input = original.querySelector('input')!; input.focus(); input.setSelectionRange(2, 8)
  await act(async () => surface.showPopover())
  expect(surface.matches(':popover-open')).toBe(true)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })))
  expect(surface.matches(':popover-open')).toBe(true)
  expect(parentOpenChange).not.toHaveBeenCalled()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(surface.matches(':popover-open')).toBe(false)
  expect(parentOpenChange).not.toHaveBeenCalled()
  expect(original.dataset.state).toBe('open')
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Original unsent draft', 2, 8])
})

it.each(cases)('$name closes its original native top-layer surface before its retained source scope closes', async ({ content, selector }) => {
  const child = content(); await scene(true, child)
  const surface = document.querySelector<HTMLElement>(selector)!
  await act(async () => surface.showPopover())
  expect(surface.matches(':popover-open')).toBe(true)
  await scene(false, child)
  expect(surface.isConnected).toBe(true)
  expect(surface.matches(':popover-open')).toBe(false)
  expect(document.querySelector<HTMLElement>('[data-overlay-modal-scope]')!.hidden).toBe(true)
})
