import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'
import { createNativeInputCorrelation, nativeInputCorrelationKey } from '../src/native-input-correlation.js'

const key = { kind: 'prompt' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, submissionId: 'original-input' }
// This is the original Node UTF-8/base64url wire, not a new token format.
const original = 'amux-input-v1.' + Buffer.from(JSON.stringify({ key, nonce: Buffer.alloc(24, 123).toString('base64url') })).toString('base64url')

it('retains original correlation bytes, entropy and canonical decoding', () => {
  expect(nativeInputCorrelationKey(original)).toEqual(key)
  const next = createNativeInputCorrelation(key)
  expect(nativeInputCorrelationKey(next)).toEqual(key)
  const body = JSON.parse(Buffer.from(next.slice('amux-input-v1.'.length), 'base64url').toString('utf8'))
  expect(Buffer.from(body.nonce, 'base64url')).toHaveLength(24)
  expect(createNativeInputCorrelation(key)).not.toBe(next)
  for (const invalid of [original + '=', 'wrong.' + original, 'amux-input-v1._w', 'amux-input-v1.' + 'A'.repeat(8192)]) {
    expect(nativeInputCorrelationKey(invalid)).toBeNull()
  }
})

it('executes the actual browser bundle without Node globals', () => {
  const bundle = buildSync({ entryPoints: [new URL('../src/native-input-correlation.ts', import.meta.url).pathname],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Correlation', target: 'es2022' }).outputFiles[0]!.text
  const context = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, structuredClone, original, key }
  runInNewContext(bundle + '; globalThis.result = {old:Correlation.nativeInputCorrelationKey(original), next:Correlation.nativeInputCorrelationKey(Correlation.createNativeInputCorrelation(key))}', context)
  expect((context as typeof context & { result: unknown }).result).toEqual({ old: key, next: key })
})
