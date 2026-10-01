// @vitest-environment happy-dom
import { createElement } from 'react'
import { composerDOM } from './helpers/composer-dom-fixture'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { ComposerOutbox, type ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox.js'

const dom = composerDOM()
async function render(queued: ComposerQueuedMessage[], copy = true, selectedId = queued[0]?.id ?? null): Promise<string> {
  await dom.render(createElement(ComposerOutbox, {
    queued, selectedId, onSelect: () => {},
    onSend: () => {}, onRemove: () => {}, ...(copy ? { onCopy: async () => true } : {})
  }))
  if (dom.container.querySelector('[aria-label="Message details"][aria-expanded="false"]')) await dom.click('[aria-label="Message details"]')
  return dom.container.innerHTML
}
const entry = (overrides: Partial<ComposerQueuedMessage> = {}): ComposerQueuedMessage => ({
  id: 'q1', text: 'Keep these exact words', status: 'queued', deliverable: true, ...overrides
})

describe('queue delivery facts and recovery actions', async () => {
  it('describes explicit per-message steer without promising an automatic tail', async () => {
    const html = await render([entry()])
    expect(html).toContain('Queued for delivery.')
    expect(html).toContain('Send explicitly steers only this message, including during the current turn.')
    expect(html).toContain('other queued messages are not sent automatically.')
    expect(html).toContain('Restored messages wait for your explicit Send')
    expect(html).not.toContain('finishes its current turn')
    expect(html).not.toContain('role="status"')
    expect(html).toContain('Keep these exact words')
  })

  it('keeps the deferred reason and recovery actions with the message, without a second permanent banner', async () => {
    const html = await render([entry({ status: 'deferred', error: 'Readiness not observed Diagnostic: latestOutputBytes=123' })])
    expect(html).toContain('Readiness not observed')
    expect(html).toContain('data-state="deferred"')
    expect(html).toContain('Send queued message')
    expect(html).not.toContain('composer__queue-notice')
    expect(html).not.toContain('role="status"')
  })

  it('does not promise automatic delivery of a deferred entry whose Run ended', async () => {
    const html = await render([entry({ status: 'deferred', deliverable: false, error: 'Not ready earlier' })])
    expect(html).toContain('the bound Run is unavailable or changed')
    expect(html).toContain('Keep these exact words')
    expect(html).toContain('Copy message')
    expect(html).not.toContain('retries when')
    expect(html).not.toContain('Send queued message')
    expect(html).toContain('Keep these exact words')
  })

  it('derives actions per entry when old and current Runs coexist', async () => {
    const html = await render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })])
    expect(html).toContain('the bound Run is unavailable or changed')
    expect(html.match(/aria-label="Remove"/g)).toHaveLength(1)
    expect(html).not.toContain('Send queued message')
    const current = await render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })], true, 'q2')
    expect(current.match(/Send queued message/g)).toHaveLength(1)
    expect(current.match(/aria-label="Remove"/g)).toHaveLength(1)
    expect(current).toContain('Current Run')
    expect(await render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })], true, null)).toContain('Copy all')
  })

  it('never offers to recall an in-flight message and disables competing manual retry', async () => {
    const html = await render([entry({ sending: true })])
    expect(html).toContain('Waiting for delivery confirmation')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove"/)
    expect(html).toMatch(/<button(?=[^>]*aria-label="Send queued message")(?=[^>]*disabled="")[^>]*>Send<\/button>/)
  })

  it('shares single-record Copy while bulk Copy remains supplied by the host', async () => {
    const html = await render([entry({ deliverable: false })], false)
    expect(html).toContain('Keep these exact words')
    expect(html).not.toContain('copy them')
    expect(html).toContain('Copy message');expect(await render([entry()],false,null)).not.toContain('Copy all')
  })
})
