// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement, type MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal'
import { BrowserResultArtifactStore } from '../src/main/browser-result-artifact'
import { BrowserStepEvidenceStore } from '../src/main/browser-step-evidence'
import { extractBrowserStructuredOutput } from '../src/main/browser-structured-output'
import { evaluateBrowserOutcomeCriteria, type BrowserOutcomeCurrent, type BrowserOutcomeHost } from '../src/main/browser-outcome-criteria'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import { BROWSER_OUTCOME_LIMITS, parseBrowserOutcomeCriteriaRequest, type BrowserOutcomeHumanFact,
  type BrowserOutcomeRegistration, type BrowserOutcomeFieldRunInput } from '../src/shared/browser-outcome-criteria'
import type { BrowserStructuredDocument, BrowserStructuredOutputRequest } from '../src/shared/browser-structured-output'
import type { BrowserDownloadReceipt, BrowserDownloadReference, BrowserDownloadChunk } from '../src/shared/browser-download'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const owned: string[] = []
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }) })
const context = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const run = { runId: 'run-a', assetId: 'asset-a', version: 1 }
const scalarField = (key: string, type: 'string' | 'number' | 'boolean', selector = `#${key}`) => ({ key, type, source: { selector, read: type === 'boolean' ? 'checked' as const : 'text' as const } })

async function fixture(expected: string | number | boolean = 'ready', options: { fields?: BrowserStructuredOutputRequest['fields']; html?: string } = {}) {
  document.body.innerHTML = options.html ?? '<span id="result">ready</span>'
  const directory = await mkdtemp(join(tmpdir(), 'amux-outcome-'))
  owned.push(directory)
  const journalPath = join(directory, 'journal.json'), evidencePath = join(directory, 'evidence'), resultPath = join(directory, 'results')
  let journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
  let evidenceStore = new BrowserStepEvidenceStore(evidencePath), resultStore = new BrowserResultArtifactStore(resultPath)
  await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person-a', name: 'Person' }, summary: 'Check declared field', url: 'https://generic.invalid/form' })
  const step = await journal.startStep(context.operationId, { method: 'extractStructured', label: 'Observe declared field' })
  if (!step) throw new Error('No actual journal step')
  const request = { fields: options.fields ?? [scalarField('result', typeof expected as 'string' | 'number' | 'boolean')] }
  const registration: BrowserOutcomeRegistration = { context, criteria: [{ kind: 'field-equals', key: 'result', expected,
    producer: { operationId: context.operationId, navigationId: context.navigationId, sequence: step.sequence, request } }] }
  let domReads = 0, documentCurrent = true
  let captured!: BrowserStructuredDocument
  const receipt = await extractBrowserStructuredOutput(request, {
    source: { ...context, url: 'https://generic.invalid/form', document: 'actual-frame:17', scope: { kind: 'page' } },
    isCurrent: () => documentCurrent,
    read: async (declaration, request) => { domReads += 1; return Function(`return (${declaration})`)().call(document, request) },
    register: async (value, source) => { captured = value; return resultStore.registerJSON(source, value) }
  })
  const reference = await evidenceStore.write({ operationId: context.operationId, browserId: context.browserId,
    sequence: step.sequence, navigationId: context.navigationId }, { kind: 'structured-output', receipt })
  await journal.finishStep(context.operationId, step.sequence, { status: 'completed', evidence: [reference] })
  let current: BrowserOutcomeCurrent = { workspaceId: context.workspaceId, browserId: context.browserId, navigationId: context.navigationId, assetRun: null }
  const host: BrowserOutcomeHost = {
    current: () => current,
    getOperation: id => journal.get(id),
    getStepEvidence: async (operationId, sequence) => ({ operationId, sequence, status: 'available', items: [await evidenceStore.read(reference)] }),
    readStepResult: vi.fn(async (_operationId, _sequence, options) => resultStore.read(receipt.artifact!, current, options)),
    isStructuredSourceCurrent: vi.fn(async source => documentCurrent && source.document === 'actual-frame:17')
  }
  return { registration, host, receipt, captured, reference, journal, directory, reads: () => domReads,
    setCurrent: (value: BrowserOutcomeCurrent) => { current = value }, current: () => current,
    changeDocument: () => { documentCurrent = false },
    restart: async () => { journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath));
      evidenceStore = new BrowserStepEvidenceStore(evidencePath); resultStore = new BrowserResultArtifactStore(resultPath); await journal.ready() }
  }
}

describe('finite conditions joined to actual Main producers', () => {
  it('uses real extraction, journal evidence and T003 bytes; summary previews and script exit are unnecessary', async () => {
    const f = await fixture()
    expect(f.receipt.artifactStatus).toBe('available')
    expect(f.captured.fields).toHaveLength(1)
    const result = await evaluateBrowserOutcomeCriteria(f.registration, f.host)
    expect(result.status).toBe('passed')
    expect(result.conditions.map(item => item.status)).toEqual(['passed'])
    expect(f.host.readStepResult).toHaveBeenCalledTimes(1)
    expect(f.reads()).toBe(1)
    expect(JSON.stringify(result)).not.toContain('actual-frame:17')
    expect(result.conditions[0]).not.toHaveProperty('actual')
  })

  it.each([['', '<span id="result"></span>'], [0, '<span id="result">0</span>'], [false, '<input id="result" type="checkbox">']] as const)
    ('observed primitive %s is a value rather than absence', async (expected, html) => {
      const f = await fixture(expected, { html })
      expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('passed')
      expect(f.reads()).toBe(1)
    })

  it.each([
    ['different', '<span id="result">other</span>', 'not-met'],
    ['missing', '<span></span>', 'not-met'],
    ['ambiguous', '<span id="result">ready</span><span id="result">ready</span>', 'unavailable'],
    ['truncated', `<span id="result">${'r'.repeat(16385)}</span>`, 'unavailable']
  ] as const)('keeps %s separate from completion', async (_kind, html, status) => {
    const f = await fixture('ready', { html })
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe(status)
  })

  it('a typed read error is not met; declared type mismatch is unavailable', async () => {
    const f = await fixture(0, { html: '<span id="result"></span>' })
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('not-met')
    f.registration.criteria[0] = { ...f.registration.criteria[0]!, kind: 'field-equals', key: 'result', expected: false,
      producer: { operationId: context.operationId, navigationId: context.navigationId, sequence: 1, request: { fields: [scalarField('result', 'number')] } } }
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
  })

  it('rejects a previous operation, a different browser/workspace and actual run/version mismatch', async () => {
    const f = await fixture()
    const old = structuredClone(f.registration)
    old.context.operationId = 'another-execution'
    expect((await evaluateBrowserOutcomeCriteria(old, f.host)).status).toBe('unavailable')
    for (const changed of [ { ...f.current(), browserId: 'browser-b' }, { ...f.current(), workspaceId: 'workspace-b' },
      { ...f.current(), workspaceId: null } ]) {
      f.setCurrent(changed)
      expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
    }
    const registration = { ...f.registration, assetRun: run }
    for (const assetRun of [ { ...run, version: 2, operationIds: [context.operationId] },
      { ...run, runId: 'another-run', operationIds: [context.operationId] }, { ...run, operationIds: ['historic-operation'] } ]) {
      f.setCurrent({ workspaceId: context.workspaceId, browserId: context.browserId, navigationId: context.navigationId, assetRun })
      expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('unavailable')
    }
    f.setCurrent({ workspaceId: context.workspaceId, browserId: context.browserId, navigationId: context.navigationId,
      assetRun: { ...run, operationIds: [context.operationId] } })
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('passed')
  })

  it('a schema-shaped script return or unjoined evidence cannot satisfy a journal step', async () => {
    const f = await fixture()
    const original = f.host.getOperation
    f.host.getOperation = async id => { const op = (await original(id))!; return { ...op, phase: 'completed', steps: op.steps.map(step => ({ ...step, method: 'js' })) } }
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
    f.host.getOperation = original
    const evidence = await f.host.getStepEvidence(context.operationId, 1)
    f.host.getStepEvidence = async () => ({ ...evidence, items: evidence.items.map(item => ({ ...item, reference: { ...item.reference, id: 'unjoined' } })) })
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
    expect(f.host.readStepResult).toHaveBeenCalledTimes(0)
  })

  it('registration navigation must match a standalone producer; asset producers retain their own navigation', async () => {
    const f = await fixture()
    const changed = structuredClone(f.registration)
    changed.context.navigationId = 'foreign-registration-nav'
    expect((await evaluateBrowserOutcomeCriteria(changed, f.host)).status).toBe('unavailable')
    changed.assetRun = run
    f.setCurrent({ ...f.current(), assetRun: { ...run, operationIds: [context.operationId] } })
    expect((await evaluateBrowserOutcomeCriteria(changed, f.host)).status).toBe('passed')
  })

  it('does not evaluate a matching preview when complete bytes differ, are unavailable or exceed the whole JSON budget', async () => {
    const f = await fixture('ready', { html: '<span id="result">other</span>' })
    const evidence = await f.host.getStepEvidence(context.operationId, 1)
    const item = evidence.items[0]!
    if (item.content.kind !== 'structured-output') throw new Error('No actual extraction')
    item.content.receipt.fields[0] = { ...item.content.receipt.fields[0]!, status: 'observed', inline: true, value: 'ready', preview: 'ready' }
    f.host.getStepEvidence = async () => evidence
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('not-met')
    f.host.readStepResult = vi.fn(async () => { throw new Error('raw-private-page-value') })
    const unavailable = await evaluateBrowserOutcomeCriteria(f.registration, f.host)
    expect(unavailable.status).toBe('unavailable')
    expect(JSON.stringify(unavailable)).not.toContain('raw-private-page-value')
    item.content.receipt.artifact!.byteLength = BROWSER_OUTCOME_LIMITS.documentBytes + 1
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
    expect(f.host.readStepResult).toHaveBeenCalledTimes(1)
  })

  it('checks exact request and actual document after awaits; child navigation in a stable main channel is unavailable', async () => {
    const f = await fixture()
    const changed = structuredClone(f.registration)
    if (changed.criteria[0]?.kind !== 'field-equals') throw new Error('No field condition')
    changed.criteria[0].producer.request.fields[0]!.source.selector = '.similar-looking'
    expect((await evaluateBrowserOutcomeCriteria(changed, f.host)).status).toBe('unavailable')
    const read = f.host.readStepResult
    f.host.readStepResult = async (...args) => { const value = await read(...args); f.changeDocument(); return value }
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
    expect(f.current().navigationId).toBe(context.navigationId)
    expect(f.reads()).toBe(1)
  })

  it('restores stored facts without recapturing and rejects bad continuation ranges and foreign artifacts', async () => {
    const f = await fixture()
    await f.restart()
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('passed')
    const read = f.host.readStepResult
    for (const transform of [
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, offset: 1 }),
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, nextOffset: 1 }),
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, reference: { ...chunk.reference, operationId: 'old-operation' } }),
      (chunk: Awaited<ReturnType<typeof read>>) => ({ ...chunk, returnedBytes: 0, data: '' })
    ]) {
      f.host.readStepResult = async (...args) => transform(await read(...args))
      expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
    }
    expect(f.reads()).toBe(1)
  })

  it('decodes bounded multi-chunk JSON and rejects a schema-valid document from another extraction source', async () => {
    const fields = [scalarField('result', 'string'), ...Array.from({ length: 6 }, (_, i) => scalarField(`long${i}`, 'string'))]
    const f = await fixture('ready', { fields, html: '<span id="result">ready</span>' + Array.from({ length: 6 }, (_, i) => `<span id="long${i}">${'🙂'.repeat(4000)}</span>`).join('') })
    expect(f.receipt.artifact!.byteLength).toBeGreaterThan(65536)
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('passed')
    expect(f.host.readStepResult).toHaveBeenCalledTimes(2)
    const foreign = { ...f.captured, source: { ...f.captured.source, document: 'other-frame:18' } }
    const bytes = Buffer.from(JSON.stringify(foreign)), reference = { ...f.receipt.artifact!, byteLength: bytes.length }
    const evidence = await f.host.getStepEvidence(context.operationId, 1)
    const item = evidence.items[0]!
    if (item.content.kind !== 'structured-output') throw new Error('No extraction')
    item.content.receipt.artifact = reference
    f.host.isStructuredSourceCurrent = async () => true // Both frame documents can be current; only the original source qualifies.
    f.host.getStepEvidence = async () => evidence
    f.host.readStepResult = async (_op, _seq, options) => { const part = bytes.subarray(options.offset!, options.offset! + options.maxBytes!); const end = options.offset! + part.length
      return { reference, encoding: 'base64', data: part.toString('base64'), offset: options.offset!, returnedBytes: part.length,
        totalBytes: bytes.length, nextOffset: end < bytes.length ? end : null, readCost: { metadataBytes: 1, payloadBytes: part.length } } }
    expect((await evaluateBrowserOutcomeCriteria(f.registration, f.host)).status).toBe('unavailable')
  })

  it('requires nonempty finite conditions, at most eight, no arbitrary operators and a total declaration budget', async () => {
    const f = await fixture()
    for (const criteria of [[], Array.from({ length: 9 }, () => ({ kind: 'field-equals', key: 'result', expected: 'ready' })),
      [{ kind: 'expression', expression: 'true' }], Array.from({ length: 8 }, (_, i) => ({ kind: 'field-equals', key: `k${i}`, expected: '🙂'.repeat(4000) })) ]) {
      expect(() => parseBrowserOutcomeCriteriaRequest({ criteria })).toThrow()
    }
    expect((await evaluateBrowserOutcomeCriteria({ ...f.registration, criteria: [] }, f.host)).status).toBe('unavailable')
    const eight = Array.from({ length: 8 }, () => structuredClone(f.registration.criteria[0]!))
    const result = await evaluateBrowserOutcomeCriteria({ ...f.registration, criteria: eight }, f.host)
    expect(result.conditions).toHaveLength(8)
    expect(result.conditions.map(value => value.status)).toEqual(Array(8).fill('passed'))
  })

  it('a completed file requires current producer and actual readable revision; old same-path files never qualify', async () => {
    const f = await fixture()
    const registration: BrowserOutcomeRegistration = { context, criteria: [{ kind: 'download-readable', path: 'file.bin', producer: context }] }
    const reference = { ...context, workspaceId: context.workspaceId, kind: 'browser-download-file' as const, id: 'download-a', path: 'file.bin', revision: 'revision-a',
      byteLength: 2, filename: 'file.bin', mime: 'application/octet-stream', capturedAt: 1, url: 'https://generic.invalid/download' }
    const receipt: BrowserDownloadReceipt = { ...context, id: reference.id, status: 'completed', path: reference.path, reference,
      filename: reference.filename, mime: reference.mime, receivedBytes: 2, totalBytes: 2, createdAt: 1, updatedAt: 2, url: reference.url }
    f.host.getDownloads = async () => [receipt]
    f.host.readDownload = vi.fn(async (ref: BrowserDownloadReference): Promise<BrowserDownloadChunk> => ({ reference: ref, encoding: 'base64', data: '/w==', offset: 0, returnedBytes: 1, totalBytes: 2, revision: ref.revision, nextOffset: 1, readCost: { payloadBytes: 1 } }))
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('passed')
    f.host.getDownloads = async () => [{ ...receipt, operationId: 'old-operation', reference: { ...reference, operationId: 'old-operation' } }]
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('unavailable')
    f.host.getDownloads = async () => [{ ...receipt, status: 'waiting' }]
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('not-met')
    f.host.getDownloads = async () => [receipt]
    f.host.readDownload = async () => { throw new Error('File replaced or unavailable') }
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('unavailable')
    expect(f.reads()).toBe(1)
  })

  it('waiting/control/cursor is not approval; only exact trusted Continue in this run and version qualifies', async () => {
    const f = await fixture()
    const registration: BrowserOutcomeRegistration = { context, assetRun: run, criteria: [{ kind: 'human-checkpoint', checkpointId: 'checkpoint-a' }] }
    f.setCurrent({ ...f.current(), assetRun: { ...run, operationIds: [context.operationId] } })
    f.host.getHumanCheckpoint = async () => null
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('not-met')
    const fact: BrowserOutcomeHumanFact = { ...run, browserId: context.browserId, checkpointId: 'checkpoint-a', origin: 'trusted-ui', controlBefore: 'human', confirmedAt: 5 }
    for (const changed of [{ ...fact, origin: 'agent' }, { ...fact, version: 2 }, { ...fact, runId: 'prior-run' }, { ...fact, controlBefore: 'agent' }]) {
      f.host.getHumanCheckpoint = async () => changed as BrowserOutcomeHumanFact
      expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('unavailable')
    }
    f.host.getHumanCheckpoint = async () => fact
    expect((await evaluateBrowserOutcomeCriteria(registration, f.host)).status).toBe('passed')
    expect(f.host.readStepResult).toHaveBeenCalledTimes(0)
  })
})

describe('local Browser outcome editor', () => {
  it('emits the finite declared request and original event to the trusted Pane boundary, without evaluating by itself', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    document.body.append(host)
    const onRun = vi.fn(async (_input: BrowserOutcomeFieldRunInput, _event: MouseEvent<HTMLButtonElement>) => {})
    try {
      await act(async () => root.render(createElement(BrowserOutcomeCriteria, { onRun })))
      const inputs = [...host.querySelectorAll<HTMLInputElement>('input')]
      expect(inputs).toHaveLength(3)
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[1], '#result')
        inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const button = host.querySelector<HTMLButtonElement>('button')!
      await act(async () => button.click())
      expect(onRun).toHaveBeenCalledTimes(1)
      expect(onRun.mock.calls[0]?.[0]).toEqual({ request: { fields: [scalarField('result', 'string')] }, criteria: [{ kind: 'field-equals', key: 'result', expected: '' }] })
      // The leaf forwards this event; only Main/Pane's real trusted caller can authorize a run.
      expect(onRun.mock.calls[0]?.[1]?.nativeEvent.type).toBe('click')
      expect(host.querySelectorAll('[role=status]')).toHaveLength(0)
    } finally { await act(async () => root.unmount()); host.remove() }
  })
  it('projects distinct result states and concrete reasons without another rail or raw observed values', async () => {
    const f = await fixture()
    const host = document.createElement('div'), root = createRoot(host)
    try {
      const onRun = vi.fn(async () => {})
      const evaluation = await evaluateBrowserOutcomeCriteria(f.registration, f.host)
      for (const status of ['passed', 'not-met', 'unavailable'] as const) {
        await act(async () => root.render(createElement(BrowserOutcomeCriteria, { evaluation: { ...evaluation, status }, onRun })))
        expect(host.querySelectorAll('details')).toHaveLength(1)
        expect(host.querySelectorAll('label')).toHaveLength(4)
        expect(host.querySelectorAll('[role=status]')).toHaveLength(1)
        expect(host.querySelector('[role=status]')?.textContent).toContain(evaluation.conditions[0]!.reason)
      }
      expect(host.querySelector('pre')).toBeNull()
      expect(onRun).toHaveBeenCalledTimes(0)
      const button = host.querySelector<HTMLButtonElement>('button')!
      await act(async () => button.click())
      expect(onRun).toHaveBeenCalledTimes(0)
      expect(host.textContent).toContain('Use a CSS selector')
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
