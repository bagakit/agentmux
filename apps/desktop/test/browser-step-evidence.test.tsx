// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserStepEvidenceStore, pageStepEvidence, recordBrowserStepEvidence } from '../src/main/browser-step-evidence'
import type { BrowserOperation, BrowserOperationStep } from '../src/shared/browser-operation'
import type { BrowserStepEvidenceRead } from '../src/shared/browser-step-evidence'
import type { BrowserStructuredOutputReceipt } from '../src/shared/browser-structured-output'
import { BrowserStepEvidence } from '../src/renderer/src/components/BrowserStepEvidence'

const bridge = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: { getStepEvidence: bridge.get, readStepResult: bridge.read } } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const identity = { operationId: 'op-a', sequence: 1, browserId: 'browser-a', navigationId: 'nav-a' }
const content = { kind: 'diagnostic' as const, code: 'page-call-failed' as const, message: 'Step 1 failed.', nextAction: 'Inspect the page.' }

describe('saved Browser step evidence', () => {
  it('keeps exact operation, step and navigation identity across a store restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-step-evidence-'))
    try {
      const reference = await recordBrowserStepEvidence(new BrowserStepEvidenceStore(root), identity, content)
      expect(reference).toMatchObject({ ...identity, kind: 'diagnostic', byteLength: Buffer.byteLength(JSON.stringify(content)) })
      const restarted = new BrowserStepEvidenceStore(root)
      await expect(restarted.read(reference)).resolves.toEqual({ reference, content })
      await expect(restarted.read({ ...reference, sequence: 2 })).rejects.toThrow('does not belong')
      await expect(restarted.read({ ...reference, navigationId: 'nav-b' })).rejects.toThrow('does not belong')
      await expect(restarted.read({ ...reference, operationId: 'op-b' })).rejects.toThrow('does not belong')
      await expect(restarted.read({ ...reference, id: '../../other' })).rejects.toThrow('Invalid')
      expect(await readFile(join(root, `${reference.id}.json`), 'utf8')).not.toContain('backendNodeId')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('bounds explicit page excerpts and persists no input values or raw protocol identity', () => {
    const snapshot = { url: 'https://example.test/?credential=private', title: 'Results', navigationId: 'nav-a',
      nodes: Array.from({ length: 200 }, (_, i) => ({ ref: `@e${i + 1}`, role: 'button', name: `Row ${i + 1}`, depth: 0, backendNodeId: i + 100 })), missingFrames: [] }
    const result = pageStepEvidence(snapshot)
    expect(result.kind).toBe('page')
    expect(result).toMatchObject({ truncated: true })
    const saved = JSON.stringify(result)
    expect(saved).toContain('@e128')
    expect(saved).not.toContain('@e129')
    expect(saved).not.toContain('credential')
    expect(saved).not.toContain('backendNodeId')
  })
})

function operation(id: string, browserId = 'browser-a'): BrowserOperation {
  return { id, browserId, operator: { id: 'agent-a', name: 'Agent' }, startedAt: 1, phase: 'failed', summary: 'Failed', url: '', steps: [] }
}
function step(sequence: number): BrowserOperationStep {
  return { sequence, method: 'click', label: `Action ${sequence}`, status: 'failed', startedAt: 1, finishedAt: 2 }
}
function response(operationId: string, sequence: number, text: string): BrowserStepEvidenceRead {
  return { operationId, sequence, status: 'available', items: [{
    reference: { ...identity, operationId, sequence, id: `${operationId}-${sequence}`, kind: 'page', capturedAt: 1, byteLength: text.length },
    content: { kind: 'page', text, truncated: false }
  }] }
}

describe('selected step evidence in the production component', () => {
  it('mounts saved structured fields and reads their JSON only on demand through the actual step identity', async () => {
    const bytes = Buffer.from(JSON.stringify({ zero: 0, empty: '', flag: false }))
    const artifact = { kind: 'browser-result-artifact' as const, id: 'structured-result', format: 'json' as const,
      workspaceId: 'workspace-a', operationId: identity.operationId, browserId: identity.browserId,
      navigationId: identity.navigationId, capturedAt: 1, byteLength: bytes.byteLength, maxReadBytes: 65536 }
    const receipt: BrowserStructuredOutputReceipt = { kind: 'browser-structured-output', status: 'partial',
      source: { workspaceId: 'workspace-a', operationId: identity.operationId, browserId: identity.browserId,
        navigationId: identity.navigationId, url: 'https://fixture.invalid/', document: 'document:11',
        documentUrl: 'https://fixture.invalid/', scope: { kind: 'page' } },
      fields: [
        { key: 'zero', type: 'number', source: { selector: '#zero', read: 'text' }, status: 'observed', inline: true, value: 0 },
        { key: 'empty', type: 'string', source: { selector: '#empty', read: 'value' }, status: 'observed', inline: true, value: '' },
        { key: 'flag', type: 'boolean', source: { selector: '#flag', read: 'checked' }, status: 'observed', inline: true, value: false },
        { key: 'missing', type: 'string', source: { selector: '.absent', read: 'text' }, status: 'missing', inline: false },
        { key: 'invalid', type: 'number', source: { selector: '#empty', read: 'value' }, status: 'type-error', inline: false, actual: '' }
      ], work: null, artifactStatus: 'available', artifact }
    bridge.get.mockReset().mockResolvedValue({ operationId: identity.operationId, sequence: identity.sequence,
      status: 'available', items: [{ reference: { ...identity, id: 'structured-evidence', kind: 'structured-output',
        capturedAt: 1, byteLength: Buffer.byteLength(JSON.stringify(receipt)) }, content: { kind: 'structured-output', receipt } }] })
    bridge.read.mockReset().mockResolvedValue({ reference: artifact, encoding: 'base64', data: bytes.toString('base64'),
      offset: 0, returnedBytes: bytes.byteLength, totalBytes: bytes.byteLength, nextOffset: null,
      readCost: { metadataBytes: 1, payloadBytes: bytes.byteLength } })
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStepEvidence, {
        operation: { ...operation(identity.operationId), phase: 'completed' },
        step: { ...step(identity.sequence), method: 'extractStructured', label: 'extractStructured', status: 'completed' }
      })))
      expect(host.querySelector('section.browser-step-evidence')?.getAttribute('aria-label')).toBe('Evidence for step 1: extractStructured')
      expect(host.querySelector('.browser-step-evidence > header')?.textContent).toBe('completed')
      expect(host.querySelector('.browser-step-evidence__time')?.textContent).not.toContain('Fields')
      expect(host.querySelector('.browser-structured-fields__summary')?.textContent).toContain('Partial')
      const source = [...host.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Source')!
      expect(source).toBeDefined()
      expect(source.open).toBe(false)
      expect([...source.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['Action', 'Operation', 'Step', 'Browser', 'Navigation'])
      expect([...source.querySelectorAll('dd')].map(term => term.textContent)).toEqual(['extractStructured', identity.operationId, String(identity.sequence), identity.browserId, identity.navigationId])
      expect([...host.querySelectorAll('.browser-structured-fields__values > div')].map(row =>
        [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]))
        .toEqual([['zero', '0'], ['empty', '""'], ['flag', 'false'], ['missing', 'Missing'], ['invalid', 'Type mismatch""']])
      expect(bridge.read).not.toHaveBeenCalled()
      const raw = [...host.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Recorded JSON')
      expect(raw).toBeDefined()
      await act(async () => { raw!.open = true; raw!.dispatchEvent(new Event('toggle')) })
      expect(bridge.read.mock.calls).toEqual([[identity.operationId, identity.sequence, { offset: 0, maxBytes: 65536 }]])
      expect(host.querySelector('pre')?.textContent).toBe(bytes.toString('utf8'))
      expect(bridge.get.mock.calls).toEqual([[identity.operationId, identity.sequence]])
    } finally { await act(async () => root.unmount()) }
  })

  it('does not show late evidence from the previous selection or a foreign Browser', async () => {
    let first!: (value: BrowserStepEvidenceRead) => void
    let second!: (value: BrowserStepEvidenceRead) => void
    bridge.get.mockReset().mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStepEvidence, { operation: operation('op-a'), step: step(1) })))
      await act(async () => root.render(createElement(BrowserStepEvidence, { operation: operation('op-a'), step: step(2) })))
      await act(async () => second(response('op-a', 2, 'right-step')))
      expect(host.querySelector('pre')?.textContent).toBe('right-step')
      await act(async () => first(response('op-a', 1, 'wrong-step')))
      expect(host.querySelector('pre')?.textContent).toBe('right-step')
      bridge.get.mockResolvedValueOnce(response('op-b', 1, 'foreign-browser'))
      await act(async () => root.render(createElement(BrowserStepEvidence, { operation: operation('op-b', 'browser-b'), step: step(1) })))
      expect(host.querySelector('pre')).toBeNull()
      expect(host.textContent).toContain('Recorded evidence could not be read')
      expect(host.textContent).not.toContain('foreign-browser')
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps the step visible on failed reads and retries without recapturing the page', async () => {
    bridge.get.mockReset().mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce(response('op-a', 3, 'saved-page'))
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStepEvidence, { operation: operation('op-a'), step: step(3) })))
      expect(host.textContent).toContain('Action 3')
      expect(host.textContent).toContain('could not be read')
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
      expect(bridge.get.mock.calls).toEqual([['op-a', 3], ['op-a', 3]])
      expect(host.querySelector('pre')?.textContent).toBe('saved-page')
    } finally { await act(async () => root.unmount()) }
  })
})
