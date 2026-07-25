import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerWindowResizeEvents } from '../src/main/window-resize-events.js'
import { WINDOW_RESIZE_EVENT_CHANNEL } from '../src/shared/contracts.js'

function fakeWindow() {
  const emitter = new EventEmitter()
  const send = vi.fn()
  const window = Object.assign(emitter, {
    webContents: {
      isDestroyed: () => false,
      send
    }
  }) as unknown as BrowserWindow
  return { emitter, send, window }
}

describe('native window resize event owner', () => {
  it('publishes one start and one end for repeated native resize events', () => {
    const { emitter, send, window } = fakeWindow()
    registerWindowResizeEvents(window)

    emitter.emit('will-resize')
    emitter.emit('will-resize')
    emitter.emit('resized')
    emitter.emit('resized')

    expect(send.mock.calls).toEqual([
      [WINDOW_RESIZE_EVENT_CHANNEL, { active: true }],
      [WINDOW_RESIZE_EVENT_CHANNEL, { active: false }]
    ])
  })

  it('removes every owned listener when the window closes', () => {
    const { emitter, send, window } = fakeWindow()
    registerWindowResizeEvents(window)
    emitter.emit('closed')

    expect(emitter.listenerCount('will-resize')).toBe(0)
    expect(emitter.listenerCount('resized')).toBe(0)
    expect(emitter.listenerCount('closed')).toBe(0)

    emitter.emit('will-resize')
    emitter.emit('resized')
    expect(send).not.toHaveBeenCalled()
  })
})
