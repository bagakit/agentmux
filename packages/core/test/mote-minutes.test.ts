import { expect, it } from 'vitest'
import { moteMinutesToMs, parseMoteQuickDefaults } from '../src/mote/preferences.js'

// Every two-decimal minute count a person could type is a positive whole number of milliseconds that
// Core then stores. Before this reader, 68 of these were refused as not converting exactly.
it('reads every two-decimal minute count from 0.01 to 10.00 as whole milliseconds Core accepts', () => {
  for (let hundredths = 1; hundredths <= 1000; hundredths++) {
    const ms = moteMinutesToMs((hundredths / 100).toFixed(2))
    expect(ms).toBe(hundredths * 600)
    expect(parseMoteQuickDefaults({ conversationRollover: { kind: 'idle', idleMs: ms } }).conversationRollover).toEqual({ kind: 'idle', idleMs: ms })
  }
  expect(moteMinutesToMs(' 20 ')).toBe(1_200_000)
  expect(moteMinutesToMs('.5')).toBe(30_000)
  expect(moteMinutesToMs('1.')).toBe(60_000)
})

it('refuses text that is not a plain positive decimal duration', () => {
  for (const value of ['', ' ', '0', '0.000', '-5', '+5', '1e3', '0x10', 'Infinity', 'NaN', '1,5', '1.5.2', '20分钟', String(Number.MAX_SAFE_INTEGER)])
    expect(moteMinutesToMs(value), value).toBeNull()
})

it('keeps the heartbeat to whole minutes of at least one', () => {
  expect(moteMinutesToMs('45', { wholeMinutes: true })).toBe(2_700_000)
  expect(moteMinutesToMs('1', { wholeMinutes: true })).toBe(60_000)
  for (const value of ['0', '1.5', '.5', '1.', '-1', '1e1']) expect(moteMinutesToMs(value, { wholeMinutes: true }), value).toBeNull()
})
