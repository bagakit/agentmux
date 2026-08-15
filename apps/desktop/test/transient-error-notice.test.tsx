// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice.js'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

describe('transient error notice', () => {
  let root: ReturnType<typeof createRoot> | null = null
  let host: HTMLDivElement | null = null

  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = null
    host = null
  })

  async function render(node: React.ReactElement) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(node))
    return host
  }

  it('is a non-bottom surface with an explicit dismiss action', async () => {
    const onDismiss = vi.fn()
    const host = await render(<TransientErrorNotice error="Prompt could not be sent" dismissed={false} lastError="Prompt could not be sent" onDismiss={onDismiss} onReopen={vi.fn()} />)

    expect(host.querySelector('.error-notice')).not.toBeNull()
    expect(host.querySelector('.error-notice__close')?.getAttribute('aria-label')).toBe('Dismiss error')
    await act(async () => (host!.querySelector('.error-notice__close') as HTMLButtonElement).click())
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('keeps a deliberate reopen path after dismissal instead of deleting the message', async () => {
    const onReopen = vi.fn()
    const host = await render(<TransientErrorNotice error="Prompt could not be sent" dismissed={true} lastError="Prompt could not be sent" onDismiss={vi.fn()} onReopen={onReopen} />)

    expect(host.querySelector('.error-notice')).toBeNull()
    const reopen = host.querySelector('.error-notice__reopen') as HTMLButtonElement
    expect(reopen.textContent).toContain('Show last error')
    await act(async () => reopen.click())
    expect(onReopen).toHaveBeenCalledOnce()
  })

  // The alarm-fatigue fix. Volume must ride the SAME axis the service window uses (serviceNoticeAriaLive),
  // and the component must actually CONSUME the derived value — not merely have the axis in scope. Each case
  // pins a CONCRETE tier→(aria-live, role) correspondence; "some mapping exists" would survive a collapse.
  describe('volume rides the service-window severity axis', () => {
    // Reads the live <aside> the component renders for an active error.
    async function noticeFor(kind?: 'healthy' | 'process-degraded' | 'indeterminate' | 'agent-broken') {
      const host = await render(
        <TransientErrorNotice error="Document save failed" dismissed={false} lastError="Document save failed" onDismiss={vi.fn()} onReopen={vi.fn()} kind={kind} />
      )
      return host.querySelector('.error-notice') as HTMLElement
    }

    it('an unlabelled caller defaults to the quiet, non-interrupting tier — not a shout', async () => {
      // The reachability guard: if the component hardcodes the tier (or feeds a fixed kind), this reds.
      // Also the "no longer all-assertive" negative side — the whole point of the task.
      const notice = await noticeFor()
      expect(notice.getAttribute('aria-live')).toBe('polite')
      expect(notice.getAttribute('role')).toBe('status')
    })

    it('a dead-agent caller gets the loud, interrupting tier', async () => {
      // The "not矫枉成一律 polite" negative side: agent-broken MUST still be assertive/alert.
      const notice = await noticeFor('agent-broken')
      expect(notice.getAttribute('aria-live')).toBe('assertive')
      expect(notice.getAttribute('role')).toBe('alert')
    })

    it('a process-degraded caller (our step failed, Agent fine) stays quiet', async () => {
      const notice = await noticeFor('process-degraded')
      expect(notice.getAttribute('aria-live')).toBe('polite')
      expect(notice.getAttribute('role')).toBe('status')
    })

    it('the loud tier is strictly louder than the default — the two are not collapsed', async () => {
      // Pins the correspondence as a RELATION, so folding one tier onto the other reds regardless of which
      // way it is folded (all-polite or all-assertive both break this).
      const quiet = await noticeFor()
      const quietLive = quiet.getAttribute('aria-live')
      if (root) await act(async () => root!.unmount())
      host?.remove()
      root = null
      host = null
      const loud = await noticeFor('agent-broken')
      expect(quietLive).toBe('polite')
      expect(loud.getAttribute('aria-live')).toBe('assertive')
      expect(loud.getAttribute('aria-live')).not.toBe(quietLive)
    })
  })
})
