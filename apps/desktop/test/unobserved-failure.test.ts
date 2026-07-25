import { describe, expect, it, vi } from 'vitest'
import {
  installUnobservedFailureReporter,
  unobservedFailure
} from '../src/renderer/src/lib/unobserved-failure.js'

// A minimal stand-in for window that records what was registered, so these tests assert the listener
// contract (installed, invoked, removable) without needing a DOM.
function host() {
  const listeners = new Map<string, EventListener>()
  return {
    listeners,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener)
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type)
    }),
    emit(reason: unknown): { preventDefault: ReturnType<typeof vi.fn> } {
      const preventDefault = vi.fn()
      const listener = listeners.get('unhandledrejection')
      if (!listener) throw new Error('no unhandledrejection listener installed')
      listener({ reason, preventDefault } as unknown as Event)
      return { preventDefault }
    }
  }
}

describe('unobserved failure reporter', () => {
  it('routes a rejection nobody handled to the single error surface', () => {
    const reportError = vi.fn()
    const window = host()

    installUnobservedFailureReporter({ host: window, reportError })
    window.emit(new Error('Pasted image exceeds the size limit.'))

    expect(reportError).toHaveBeenCalledOnce()
    const reported = reportError.mock.calls[0]?.[0] as Error
    // The original detail survives: a net that reported only "something went wrong" would leave the
    // user with less than the console already had.
    expect(reported.message).toContain('Pasted image exceeds the size limit.')
  })

  it('says the failure was unexpected rather than posing as a chosen message', () => {
    // Nobody wrote these words for this situation — the handler was missing. Saying so keeps the gap
    // visible instead of dressing an escaped rejection up as a deliberate error.
    expect(unobservedFailure(new Error('boom')).message).toContain('unexpectedly')
    expect(unobservedFailure(new Error('boom')).cause).toBeInstanceOf(Error)
  })

  it('reports non-Error rejections and empty reasons without printing a useless message', () => {
    expect(unobservedFailure('plain string').message).toContain('plain string')
    // A rejection with nothing to say must still produce a sentence, not "Something failed: ".
    expect(unobservedFailure(new Error('')).message).toBe(
      'Something failed unexpectedly. No further detail was reported.'
    )
    expect(unobservedFailure(new Error('   ')).message).toBe(
      'Something failed unexpectedly. No further detail was reported.'
    )
  })

  it('stops the console double-reporting what the banner now owns', () => {
    const window = host()
    installUnobservedFailureReporter({ host: window, reportError: vi.fn() })

    // preventDefault silences the console's "Uncaught (in promise)"; the failure itself is not
    // swallowed, because it was handed to reportError in the same handler.
    expect(window.emit(new Error('boom')).preventDefault).toHaveBeenCalledOnce()
  })

  it('hands back a disposer so the listener is owned, not leaked globally', () => {
    const window = host()

    const dispose = installUnobservedFailureReporter({ host: window, reportError: vi.fn() })
    expect(window.listeners.has('unhandledrejection')).toBe(true)

    dispose()
    expect(window.listeners.has('unhandledrejection')).toBe(false)
  })
})
