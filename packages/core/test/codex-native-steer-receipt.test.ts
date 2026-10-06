import { expect, it } from 'vitest'
import { codexNativePromptReceipt } from '../src/providers/codex-native-prompt.js'

it.each(['arbitrary wording', 'no active turn', 'working', '› active', ''])('0.162 receipt uses the formal code, independent of display: %s', message => {
  expect(codexNativePromptReceipt({ jsonrpc: '2.0', id: 'operation', error: { code: -32600, message } })).toEqual({ outcome: 'not-applied', errorCode: -32600 })
  expect(codexNativePromptReceipt({ jsonrpc: '2.0', id: 'operation', error: { code: -32603, message } })).toEqual({ outcome: 'unknown', errorCode: -32603 })
})
it('reads only the matched turn/start receipt and preserves malformed successes as unknown', () => {
  expect(codexNativePromptReceipt({ jsonrpc: '2.0', id: 'operation', result: { turn: { id: 'turn', status: 'inProgress' } } })).toEqual({ outcome: 'admitted', turnId: 'turn' })
  for (const result of [null, {}, { turnId: 'turn' }, { turn: { id: '', status: 'inProgress' } }, { turn: { id: 'turn', status: 'done' } }]) expect(codexNativePromptReceipt({ jsonrpc: '2.0', id: 'operation', result })).toEqual({ outcome: 'unknown' })
})
