import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentComposer, type ComposerQueuedMessage } from '../src/renderer/src/components/AgentComposer.js'

function render(queued: ComposerQueuedMessage[], copy = true): string {
  return renderToStaticMarkup(createElement(AgentComposer, {
    value: '', disabled: false, placeholder: '', queued, onChange: () => {},
    onSendQueued: () => {}, onRemoveQueued: () => {}, ...(copy ? { onCopyQueued: () => {} } : {})
  }))
}
const entry = (overrides: Partial<ComposerQueuedMessage> = {}): ComposerQueuedMessage => ({
  id: 'q1', text: 'Keep these exact words', status: 'queued', deliverable: true, ...overrides
})

describe('queue delivery facts and recovery actions', () => {
  it('promises ordered attempts as soon as the Provider accepts, without an idle-only promise', () => {
    const html = render([entry()])
    expect(html).toContain('1 message queued for delivery')
    expect(html).toContain('as soon as the Agent can accept them')
    expect(html).not.toContain('finishes its current turn')
    expect(html).not.toContain('role="status"')
    expect(html).toContain('Keep these exact words')
  })

  it('puts the actual deferred reason outside the closed popover, with recovery instructions', () => {
    const html = render([entry({ status: 'deferred', error: 'Readiness not observed Diagnostic: latestOutputBytes=123' })])
    const statusStart = html.indexOf('role="status"')
    const cardStart = html.indexOf('popover="auto"')
    expect(statusStart).toBeGreaterThan(-1)
    expect(cardStart).toBeGreaterThan(-1)
    expect(statusStart).toBeGreaterThan(html.indexOf('aria-label="Send"'))
    const visible = html.slice(statusStart)
    expect(visible).toContain('Readiness not observed')
    expect(visible).not.toContain('latestOutputBytes')
    expect(html).toContain('Diagnostic: latestOutputBytes=123')
    expect(visible).toContain('Kept in the queue; retries when the Agent or connection becomes ready')
    expect(html).toContain('data-state="deferred"')
    expect(html).not.toContain('queued for delivery')
    expect(html).toContain('Retry queue')
  })

  it('does not promise automatic delivery of a deferred entry whose Run ended', () => {
    const html = render([entry({ status: 'deferred', deliverable: false, error: 'Not ready earlier' })])
    expect(html).toContain('cannot be sent to the current Run')
    expect(html).toContain('They are kept here')
    expect(html).toContain('Copy message')
    expect(html).not.toContain('retries when')
    expect(html).not.toContain('Retry queue')
    expect(html).toContain('Keep these exact words')
  })

  it('derives actions per entry when old and current Runs coexist', () => {
    const html = render([entry({ deliverable: false }), entry({ id: 'q2', text: 'Current Run', status: 'deferred' })])
    expect(html).toContain('1 of 2 messages cannot be sent')
    expect(html.match(/Retry queue/g)).toHaveLength(1)
    expect(html.match(/>Remove</g)).toHaveLength(2)
    expect(html).toContain('Copy all')
    expect(html).toContain('Current Run')
  })

  it('never offers to recall an in-flight message and disables competing manual retry', () => {
    const html = render([entry({ sending: true })])
    expect(html).toContain('Waiting for delivery confirmation')
    expect(html).toContain('disabled="">Remove')
    expect(html).toContain('disabled="">Retry queue')
  })

  it('only describes copying when the caller supplies that action', () => {
    const html = render([entry({ deliverable: false })], false)
    expect(html).toContain('They are kept here')
    expect(html).not.toContain('copy them')
    expect(html).not.toContain('Copy message')
  })
})
