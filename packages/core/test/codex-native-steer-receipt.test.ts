import { expect, it } from 'vitest'
import { codexNativeSteerReceipt } from '../src/providers/codex-native-prompt.js'

it.each(['arbitrary wording', 'no active turn', 'working', '› active', ''])('0.162 receipt uses the formal code, independent of display: %s', message => {
  expect(codexNativeSteerReceipt({ jsonrpc: '2.0', id: 'operation', error: { code: -32600, message } }, 'turn')).toEqual({ outcome: 'not-applied', errorCode: -32600 })
  expect(codexNativeSteerReceipt({ jsonrpc: '2.0', id: 'operation', error: { code: -32603, message } }, 'turn')).toEqual({ outcome: 'unknown', errorCode: -32603 })
})
it('admits only the original exact turn and preserves malformed/foreign successes as unknown', () => {
  expect(codexNativeSteerReceipt({ jsonrpc: '2.0', id: 'operation', result: { turnId: 'turn' } }, 'turn')).toEqual({ outcome: 'admitted', turnId: 'turn' })
  for (const result of [null, {}, { turnId: 'other' }, { turn_id: 'turn' }]) expect(codexNativeSteerReceipt({ jsonrpc: '2.0', id: 'operation', result }, 'turn')).toEqual({ outcome: 'unknown' })
})
