import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TerminalReplayGapNotice } from '../src/renderer/src/components/TerminalReplayGapNotice'

describe('TerminalReplayGapNotice', () => {
  it('offers an explicit current-screen redraw for a running Run', () => {
    const markup = renderToStaticMarkup(createElement(TerminalReplayGapNotice, {
      canRedraw: true,
      onRedraw: vi.fn(async () => true)
    }))

    expect(markup).toContain('Earlier scrollback is unavailable')
    expect(markup).toContain('Redraw current terminal screen')
  })

  it('keeps a historical Run read-only', () => {
    const markup = renderToStaticMarkup(createElement(TerminalReplayGapNotice, {
      canRedraw: false,
      onRedraw: vi.fn(async () => true)
    }))

    expect(markup).toContain('Earlier scrollback is unavailable')
    expect(markup).not.toContain('<button')
  })
})
