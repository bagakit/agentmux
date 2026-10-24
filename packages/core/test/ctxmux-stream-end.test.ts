import { describe, expect, it } from 'vitest'
import { classifyStreamEnd } from '../src/ctxmux-stream-end.js'

describe('exact Attachment end', () => {
  it('keeps a no-terminal end unknown without declaring the whole Runtime lost', () => {
    expect(classifyStreamEnd({ sawTerminalEvent: false, stillOwned: true })).toBe('observation-unavailable')
  })
  it('keeps an authoritative terminal fact distinct from observation loss', () => {
    expect(classifyStreamEnd({ sawTerminalEvent: true, stillOwned: true })).toBe('run-exited')
  })
  it.each([false, true])('ignores a superseded reader regardless of its terminal fact (%s)', sawTerminalEvent => {
    expect(classifyStreamEnd({ sawTerminalEvent, stillOwned: false })).toBe('detached')
  })
})
