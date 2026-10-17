import { expect, it } from 'vitest'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import { codexDiagnosticStream, formatCodexManagedDiagnostic } from '../src/providers/codex-managed-diagnostics.js'

async function masked(chunks: Buffer[], credentials: string[]) {
  const stream = codexDiagnosticStream(credentials), output: Buffer[] = []
  stream.on('data', value => output.push(Buffer.from(value)))
  const finished = new Promise<void>((done, fail) => { stream.on('end', done); stream.on('error', fail) })
  for (const chunk of chunks) stream.write(chunk)
  stream.end(); await finished
  return Buffer.concat(output)
}

it('preserves complete diagnostic bytes including invalid UTF-8 and long output', async () => {
  const bytes = Buffer.concat([Buffer.from('early\n' + '原生诊断'.repeat(8192)), Buffer.from([0xff, 0x80, 0x00]), Buffer.from('\nlast')])
  const chunks = Array.from({ length: Math.ceil(bytes.length / 137) }, (_, i) => bytes.subarray(i * 137, (i + 1) * 137))
  expect(await masked(chunks, ['unused-private-credential'])).toEqual(bytes)
  expect(await masked([bytes], [])).toEqual(bytes)
})

it('masks known credentials at every byte boundary and flushes an incomplete suffix unchanged', async () => {
  const credential = 'original-private-capability', bytes = Buffer.from('before=' + credential + '\nafter=' + credential + '\ntrailing-original-priv')
  const expected = Buffer.from('before=[redacted]\nafter=[redacted]\ntrailing-original-priv')
  for (let index = 0; index <= bytes.length; index++) expect(await masked([bytes.subarray(0, index), bytes.subarray(index)], [credential, credential, ''])).toEqual(expected)
  expect(await masked([...bytes].map(value => Buffer.from([value])), [credential])).toEqual(expected)
})

it('masks the longest overlapping known credential without losing surrounding bytes', async () => {
  expect(await masked([Buffer.from('one=private-key-long;two=private-key;three=untouched')], ['private-key', 'private-key-long']))
    .toEqual(Buffer.from('one=[redacted];two=[redacted];three=untouched'))
})

it('preserves the native RPC code and cause chain without changing the original exception', () => {
  const native = new JSONRPCErrorException('Original native configuration rejected: private-actor-token', -32602)
  const outer = new Error('Original resume could not be confirmed', { cause: native })
  expect(formatCodexManagedDiagnostic(outer, ['private-actor-token'])).toBe(
    'Error: Original resume could not be confirmed\nCaused by: Error [code=-32602]: Original native configuration rejected: [redacted]')
  expect(outer.cause).toBe(native); expect(native).toBeInstanceOf(JSONRPCErrorException)
  expect(native.code).toBe(-32602)
})

it('retains transport causes and handles a cyclic diagnostic chain', () => {
  const transport = Object.assign(new Error('Native transport closed'), { code: 'ECONNRESET' })
  const outer = new Error('Original launch failed', { cause: transport })
  transport.cause = outer
  expect(formatCodexManagedDiagnostic(outer, [])).toBe('Error: Original launch failed\nCaused by: Error [code=ECONNRESET]: Native transport closed')
})
