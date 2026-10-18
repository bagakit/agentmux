import { expect, it, vi } from 'vitest'
import { recoverableInitialTerminalObservation } from '../src/renderer/src/lib/terminal-initial-observation-recovery'

it('admits the original connection codes only from an own data observation', () => {
  for (const code of ['CONTROL_UNAVAILABLE', 'CONTROL_CONNECTION_FAILED', 'CTXMUX_DISCONNECTED']) {
    expect(recoverableInitialTerminalObservation(Object.assign(new Error('Connection observation unavailable'), { code }))).toBe(true)
  }
  for (const error of [null, undefined, 'CONTROL_UNAVAILABLE', { code: 'EIO' }, Object.create({ code: 'CONTROL_UNAVAILABLE' })]) {
    expect(recoverableInitialTerminalObservation(error)).toBe(false)
  }
})

it('keeps unknown error-code access non-executing and non-throwing', () => {
  const get = vi.fn(() => { throw Error('Unavailable code accessor') })
  expect(recoverableInitialTerminalObservation(Object.defineProperty(new Error('Original failure'), 'code', { get }))).toBe(false)
  expect(get).not.toHaveBeenCalled()
  const error = new Proxy(new Error('Original failure'), { getOwnPropertyDescriptor() { throw Error('Unavailable descriptor') } })
  expect(recoverableInitialTerminalObservation(error)).toBe(false)
})
