import { describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { AgentMuxHostedTransferReader, decodeBase64, encodeBase64, hostedTransfer, AGENTMUX_HOSTED_TRANSFER_MAX_BYTES } from '../src/hosted-value.js'
import { hostedCarrierPerformance } from '../src/performance-diagnostics.js'

describe('bounded Hosted carrier portable bytes', () => {
  it('accepts the exact existing logical UTF8 maximum and rejects the next byte', () => {
    const text = 'x'.repeat(AGENTMUX_HOSTED_TRANSFER_MAX_BYTES - 2)
    const reader = new AgentMuxHostedTransferReader(), chunks = hostedTransfer(text, 'legal-boundary')
    expect(chunks).toHaveLength(Math.ceil(AGENTMUX_HOSTED_TRANSFER_MAX_BYTES / (48 * 1024)))
    let value: unknown
    expect(() => chunks.forEach(chunk => { value = reader.accept(chunk) })).not.toThrow()
    expect(value).toBe(text)
    expect(() => hostedTransfer(text + 'x', 'one-over')).toThrowError(expect.objectContaining({ code: 'RUNTIME_READER_BUDGET_EXCEEDED' }))
  })
  it('roundtrips offset byte views, structured text, escaped dictionaries and tuple gaps over real framed readers', () => {
    const bytes = new Uint8Array(512 * 1024 + 8)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const value = { replay: [{ startByte: 127, dataBytes: bytes.subarray(3, bytes.length - 5) }],
      timeline: ['中文', '\u0000\"\\', undefined, { $agentmuxValue: 'bytes', data: 'ordinary user value' }] }
    const before = hostedCarrierPerformance.snapshot()
    const chunks = hostedTransfer(value, 'synthetic-carrier')
    const reader = new AgentMuxHostedTransferReader()
    let result: unknown
    expect(() => chunks.forEach((chunk, index) => {
      const next = reader.accept(JSON.parse(JSON.stringify(chunk)))
      if (index < chunks.length - 1) expect(next).toBeUndefined()
      else result = next
    })).not.toThrow()
    expect(result).toEqual(value)
    expect((result as typeof value).replay[0]!.dataBytes.constructor).toBe(Uint8Array)
    expect(encodeBase64(Uint8Array.of(9, 0, 128, 255, 8).subarray(1, 4))).toBe('AID/')
    expect(decodeBase64('AID/')).toEqual(Uint8Array.of(0, 128, 255))
    const after = hostedCarrierPerformance.snapshot()
    expect(after.encoded.count - before.encoded.count).toBe(1)
    expect(after.encodedFrames - before.encodedFrames).toBe(chunks.length)
    expect(after.decodedFrames.count - before.decodedFrames.count).toBe(chunks.length)
    expect(after.decodedValues.count - before.decodedValues.count).toBe(1)
    after.encoded.count = 0; expect(hostedCarrierPerformance.snapshot().encoded.count).toBeGreaterThan(0)
  })
  it('rejects a definitely oversized value before base64 allocation, preserves exact final escaped UTF8 budget and rejects invalid frames', () => {
    const native = vi.spyOn(Buffer.prototype, 'toString')
    try {
      const oversized = new Uint8Array(AGENTMUX_HOSTED_TRANSFER_MAX_BYTES)
      expect(() => hostedTransfer({ bytes: oversized }, 'too-large')).toThrowError(expect.objectContaining({ code: 'RUNTIME_READER_BUDGET_EXCEEDED' }))
      expect(native).not.toHaveBeenCalled()
    } finally { native.mockRestore() }
    // UTF16 lower bound is intentionally not authoritative for escaping or UTF8.
    const rejectedBefore = hostedCarrierPerformance.snapshot().rejected
    expect(() => hostedTransfer('界'.repeat(12 * 1024 * 1024), 'escaped')).toThrowError(expect.objectContaining({ code: 'RUNTIME_READER_BUDGET_EXCEEDED' }))
    expect(hostedCarrierPerformance.snapshot().rejected).toBe(rejectedBefore + 1)
    for (const value of ['A===', 'AA=A', '%%==', 'abc', 'AA\n=', 'AB==']) {
      expect(() => decodeBase64(value)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
    const allocation = vi.spyOn(Buffer, 'from')
    try {
      expect(() => new AgentMuxHostedTransferReader().accept({ transferId: 'bad-frame', index: 0,
        dataBase64: 'A'.repeat(65540), final: true })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      expect(allocation).not.toHaveBeenCalled()
    } finally { allocation.mockRestore() }
    const reader = new AgentMuxHostedTransferReader()
    const chunks = hostedTransfer({ bytes: new Uint8Array(100_000) }, 'ordered')
    reader.accept(chunks[0]!); expect(() => reader.accept(chunks[2]!)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => hostedTransfer(Symbol('unsupported'), 'invalid')).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
  it('uses the global Node fast path for exact byte views', () => {
    const native = vi.spyOn(Buffer, 'from')
    try {
      const bytes = Uint8Array.of(9, 0, 128, 255, 8).subarray(1, 4)
      expect(encodeBase64(bytes)).toBe('AID/')
      expect(native).toHaveBeenCalledWith(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      expect(decodeBase64('AID/')).toEqual(Uint8Array.of(0, 128, 255))
      expect(native).toHaveBeenCalledWith('AID/', 'base64')
    } finally { native.mockRestore() }
  })
  it('consumes the actual compiled codec in a browser context without Buffer', async () => {
    const bundled = await build({ entryPoints: [new URL('../dist/hosted-value.js', import.meta.url).pathname],
      bundle: true, platform: 'browser', format: 'cjs', write: false, metafile: true, logLevel: 'silent' })
    const inputs = Object.values(bundled.metafile!.inputs)
    expect(inputs.length).toBeGreaterThan(2)
    expect(inputs.flatMap(input => input.imports).some(input => input.path.startsWith('node:'))).toBe(false)
    expect(bundled.outputFiles[0]!.contents.byteLength).toBeGreaterThan(100)
    const context = { module: { exports: {} }, Buffer: undefined, performance, TextEncoder, TextDecoder, Uint8Array }
    runInNewContext(bundled.outputFiles[0]!.text, context)
    const browser = context.module.exports as typeof import('../src/hosted-value.js')
    const bytes = Uint8Array.of(9, 0, 128, 255, 8).subarray(1, 4)
    expect(browser.encodeBase64(bytes)).toBe('AID/')
    expect(browser.decodeBase64('AID/')).toEqual(bytes)
    const value = { bytes, text: '中文', tuple: [undefined, 'fixed'] }
    const reader = new browser.AgentMuxHostedTransferReader()
    let result: unknown
    for (const frame of browser.hostedTransfer(value, 'no-node-buffer')) result = reader.accept(frame)
    expect(result).toEqual(value)
    for (const invalid of ['A===', 'AA=A', '%%==', 'abc', 'AA\n=', 'AB==']) {
      expect(() => browser.decodeBase64(invalid)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })
})
