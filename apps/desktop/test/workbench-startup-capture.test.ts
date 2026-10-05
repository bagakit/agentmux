import { fixtureFileUrl as _hygiene_fixtureFileUrl, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { registerWorkbenchStartupCapture } from '../src/main/workbench-startup-capture.js'
import type { CrashRecord } from '../src/main/crash-capture.js'
import { beginWorkbenchBootstrap } from '../src/renderer/src/lib/renderer-startup-capture.js'

type Deps = Parameters<typeof registerWorkbenchStartupCapture>[0]
function harness(sink?: Deps['sink'], stderr?: Deps['stderr']) {
  const contents = Object.assign(new EventEmitter(), { getOSProcessId: () => 777 })
  let attempt = 'original-loader-token'
  const records: CrashRecord[] = []
  const lines: string[] = []
  const capture = registerWorkbenchStartupCapture({
    contents: contents as unknown as Deps['contents'], preloadPath: _hygiene_fixturePath("private/preload.cjs"),
    origin: () => ({ mode: 'prod', filePath: _hygiene_fixturePath("private/index.html") }), activeAttempt: () => attempt,
    startupAttemptId: 'original-main-startup', pid: 123, appVersion: 'actual-version',
    packageIdentity: { schema: 'agentmux.package-identity.v1', sourceCommit: 'actual-commit',
      sourceTree: 'actual-tree', appVersion: 'actual-version', platform: 'darwin', arch: 'arm64' },
    sink: sink ?? (record => { records.push(record) }), stderr: stderr ?? (line => { lines.push(line) }), now: () => 0
  })
  return { contents, records, lines, capture, next: () => { attempt = 'next-loader-token' } }
}
const failure = { attemptId: 'original-loader-token', event: 'renderer-import-error' as const,
  error: { name: 'Error', message: 'ORIGINAL_RENDERER_IMPORT' } }

describe('original Workbench startup capture', () => {
  it('keeps preload and first import causes with owner facts when later symptoms occur', () => {
    const h = harness()
    const error = new Error('ORIGINAL_PRELOAD')
    error.cause = { prompt: 'PRIVATE_PROMPT', env: 'PRIVATE_ENV', config: 'PRIVATE_CONFIG' }
    h.contents.emit('preload-error', {}, _hygiene_fixturePath("private/preload.cjs"), error)
    h.contents.emit('preload-error', {}, _hygiene_fixturePath("private/preload.cjs"), new Error('LATER_TIMEOUT'))
    expect(h.capture.recordRenderer(failure)).toBe(true)
    expect(h.capture.recordRenderer({ ...failure, error: { name: 'Error', message: 'LATER_WRAPPER' } })).toBe(true)
    expect(h.records.map(r => r.sourceEvent)).toEqual(['preload-error', 'renderer-import-error'])
    expect(h.records[0]).toMatchObject({ phase: 'preload', attemptId: 'original-loader-token',
      startupAttemptId: 'original-main-startup', pid: 123, rendererPid: 777,
      packageIdentity: { sourceCommit: 'actual-commit', sourceTree: 'actual-tree' } })
    expect(JSON.stringify(h.records)).toContain('ORIGINAL_PRELOAD')
    expect(JSON.stringify(h.records)).not.toMatch(/LATER_|PRIVATE_/)
  })
  it('rejects stale attempts and new events after exact Ready; next attempt retains its own first cause', () => {
    const h = harness()
    expect(h.capture.recordRenderer({ ...failure, attemptId: 'wrong-loader-token' })).toBe(false)
    h.capture.ready('wrong-loader-token')
    expect(h.capture.recordRenderer(failure)).toBe(true)
    h.capture.ready('original-loader-token')
    h.contents.emit('preload-error', {}, _hygiene_fixturePath("private/preload.cjs"), new Error('AFTER_READY'))
    expect(h.capture.recordRenderer(failure)).toBe(false)
    h.next()
    expect(h.capture.recordRenderer(failure)).toBe(false)
    expect(h.capture.recordRenderer({ ...failure, attemptId: 'next-loader-token' })).toBe(true)
    expect(h.records.map(r => r.attemptId)).toEqual(['original-loader-token', 'next-loader-token'])
    h.capture.dispose()
    expect(h.capture.recordRenderer({ ...failure, attemptId: 'next-loader-token' })).toBe(false)
    expect(h.contents.listenerCount('preload-error')).toBe(0)
  })
  it('accepts only own preload/document events and validated Error-only payload', () => {
    const h = harness()
    h.contents.emit('preload-error', {}, _hygiene_fixturePath("foreign/preload.cjs"), new Error('FOREIGN_PRELOAD'))
    h.contents.emit('did-fail-load', {}, -7, 'FOREIGN_FRAME', _hygiene_fixtureFileUrl("private/index.html"), false)
    h.contents.emit('did-fail-load', {}, -7, 'FOREIGN_DOCUMENT', _hygiene_fixtureFileUrl("foreign/index.html"), true)
    expect(h.capture.recordRenderer({ ...failure, config: 'PRIVATE_CONFIG' })).toBe(false)
    expect(h.capture.recordRenderer({ ...failure, error: { ...failure.error, prompt: 'PRIVATE_PROMPT' } })).toBe(false)
    expect(h.records).toEqual([])
    h.contents.emit('did-fail-load', {}, -7, 'ORIGINAL_DOCUMENT', _hygiene_fixtureFileUrl("private/index.html?renderer-update=original-loader-token&private-query=PRIVATE_QUERY"), true)
    expect(h.records[0]).toMatchObject({ sourceEvent: 'did-fail-load', errorCode: '-7' })
    expect(JSON.stringify(h.records)).not.toContain('PRIVATE_QUERY')
  })
  it('rejects late document failures from another original loader token before admitting the exact next attempt', () => {
    const h = harness()
    h.next()
    h.contents.emit('did-fail-load', {}, -3, 'LATE_OLD_ABORTED', _hygiene_fixtureFileUrl("private/index.html?renderer-update=original-loader-token"), true)
    h.contents.emit('did-fail-load', {}, -3, 'UNKNOWN_WITHOUT_TOKEN', _hygiene_fixtureFileUrl("private/index.html"), true)
    h.contents.emit('did-fail-load', {}, -3, 'UNKNOWN_DUPLICATE_TOKEN', _hygiene_fixtureFileUrl("private/index.html?renderer-update=next-loader-token&renderer-update=next-loader-token"), true)
    expect(h.records).toEqual([])
    const exact = _hygiene_fixtureFileUrl("private/index.html?renderer-update=next-loader-token&private-query=PRIVATE_QUERY")
    h.contents.emit('did-fail-load', {}, -7, `ORIGINAL_B_DOCUMENT ${exact}`, exact, true)
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ sourceEvent: 'did-fail-load', phase: 'document', attemptId: 'next-loader-token', errorCode: '-7' })
    expect(h.records[0]?.summary).toContain('ORIGINAL_B_DOCUMENT')
    expect(JSON.stringify(h.records)).not.toMatch(/LATE_|UNKNOWN_|renderer-update=|PRIVATE_QUERY/)
  })
  it('sink sync and async failure preserves original stderr without an exit or escaping rejection', async () => {
    for (const sink of [() => { throw Object.assign(new Error('ENOSPC diagnostic sink'), { code: 'ENOSPC' }) },
      () => Promise.reject(new Error('EIO diagnostic sink'))]) {
      const h = harness(sink)
      expect(() => h.capture.recordRenderer(failure)).not.toThrow()
      await Promise.resolve(); await Promise.resolve()
      expect(h.lines[0]).toContain('ORIGINAL_RENDERER_IMPORT')
      expect(h.lines.some(line => line.includes('diagnostic sink failed'))).toBe(true)
      h.capture.ready('original-loader-token')
      expect(h.capture.recordRenderer(failure)).toBe(false)
      h.next()
      expect(h.capture.recordRenderer({ ...failure, attemptId: 'next-loader-token' })).toBe(true)
    }
    const h = harness(() => { throw new Error('sink') }, () => { throw new Error('stderr') })
    expect(() => h.capture.recordRenderer(failure)).not.toThrow()
  })
  it('does not guess Renderer PID or package and bounds the original record including URL queries', () => {
    const h = harness()
    h.contents.getOSProcessId = () => { throw new Error('PID unavailable') }
    expect(h.capture.recordRenderer({ ...failure, error: { name: 'Error', message: ("original " + _hygiene_fixtureFileUrl("private/entry.js?PRIVATE_QUERY")),
      stack: 'stack '.repeat(20000) } })).toBe(true)
    expect(h.records[0]?.rendererPid).toBeNull()
    expect(Buffer.byteLength(h.records[0]?.detail ?? '')).toBeLessThanOrEqual(128 * 1024)
    expect(JSON.stringify(h.records)).not.toContain('PRIVATE_QUERY')
  })
})

describe('early Renderer bootstrap observer', () => {
  it('captures original error without suppressing the native event; ordinary console is not a producer', async () => {
    const host = new EventTarget()
    const records: unknown[] = []
    beginWorkbenchBootstrap({ host: host as Pick<Window, 'addEventListener' | 'removeEventListener'>,
      attemptId: 'original-loader-token', load: async () => {}, report: async input => { records.push(input); return true } })
    const event = Object.assign(new Event('error', { cancelable: true }), { error: new Error('ORIGINAL_RENDERER_ERROR') })
    host.dispatchEvent(event)
    host.dispatchEvent(Object.assign(new Event('error'), { error: new Error('LATER_WRAPPER') }))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'renderer-error', error: { message: 'ORIGINAL_RENDERER_ERROR' } })
    expect(event.defaultPrevented).toBe(false)
  })
  it('never serializes a non-Error rejection reason or lets diagnostic failure change the original event', async () => {
    const host = new EventTarget()
    const records: unknown[] = []
    beginWorkbenchBootstrap({ host: host as Pick<Window, 'addEventListener' | 'removeEventListener'>,
      attemptId: 'original-loader-token', load: async () => {}, report: async input => { records.push(input); throw new Error('sink refused') } })
    const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason: { prompt: 'PRIVATE_PROMPT', env: 'PRIVATE_ENV' } })
    expect(() => host.dispatchEvent(event)).not.toThrow()
    await Promise.resolve(); await Promise.resolve()
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_/)
    expect(records[0]).toMatchObject({ error: { name: 'UnknownError', message: 'Non-Error startup failure (object)' } })
    expect(event.defaultPrevented).toBe(false)
  })
})
