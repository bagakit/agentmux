import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerOutbox, type ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox.js'

function render(queued: ComposerQueuedMessage[], copy = true, selectedId = queued[0]?.id ?? null): string {
  return renderToStaticMarkup(createElement(ComposerOutbox, {
    queued, selectedId, onSelect: () => {},
    onSend: () => {}, onRemove: () => {}, ...(copy ? { onCopy: () => {} } : {})
  }))
}
const entry = (overrides: Partial<ComposerQueuedMessage> = {}): ComposerQueuedMessage => ({
  id: 'q1', text: 'Keep these exact words', status: 'queued', deliverable: true, ...overrides
})

describe('queue delivery facts and recovery actions', () => {
  it('describes explicit per-message steer without promising an automatic tail', () => {
    const html = render([entry()])
    expect(html).toContain('Queued for delivery.')
    expect(html).toContain('Send explicitly steers this message, including during the current turn.')
    expect(html).toContain('It does not send the other queued messages.')
    expect(html).toContain('Messages restored from a previous application session wait for your explicit Send.')
    expect(html).not.toContain('finishes its current turn')
    expect(html).not.toContain('role="status"')
    expect(html).toContain('Keep these exact words')
  })

  it('keeps the deferred reason and recovery actions with the message, without a second permanent banner', () => {
    const html = render([entry({ status: 'deferred', error: 'Readiness not observed Diagnostic: latestOutputBytes=123' })])
    expect(html).toContain('Readiness not observed')
    expect(html).toContain('data-state="deferred"')
    expect(html).toContain('Send queued message')
    expect(html).not.toContain('composer__queue-notice')
    expect(html).not.toContain('role="status"')
  })

  it('does not promise automatic delivery of a deferred entry whose Run ended', () => {
    const html = render([entry({ status: 'deferred', deliverable: false, error: 'Not ready earlier' })])
    expect(html).toContain('the bound Run is unavailable or changed')
    expect(html).toContain('Keep these exact words')
    expect(html).toContain('Copy message')
    expect(html).not.toContain('retries when')
    expect(html).not.toContain('Send queued message')
    expect(html).toContain('Keep these exact words')
  })

  it('derives actions per entry when old and current Runs coexist', () => {
    const html = render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })])
    expect(html).toContain('the bound Run is unavailable or changed')
    expect(html.match(/>Remove</g)).toHaveLength(1)
    expect(html).not.toContain('Send queued message')
    const current = render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })], true, 'q2')
    expect(current.match(/Send queued message/g)).toHaveLength(1)
    expect(current.match(/>Remove</g)).toHaveLength(1)
    expect(current).toContain('Current Run')
    expect(render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })], true, null)).toContain('Copy all')
  })

  it('never offers to recall an in-flight message and disables competing manual retry', () => {
    const html = render([entry({ sending: true })])
    expect(html).toContain('Waiting for delivery confirmation')
    expect(html).toContain('disabled="">Remove')
    expect(html).toContain('disabled="">Send queued message')
  })

  it('only describes copying when the caller supplies that action', () => {
    const html = render([entry({ deliverable: false })], false)
    expect(html).toContain('Keep these exact words')
    expect(html).not.toContain('copy them')
    expect(html).not.toContain('Copy message')
  })
})
