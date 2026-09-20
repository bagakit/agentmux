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
import { BrowserStepEvidence } from '../src/renderer/src/components/BrowserStepEvidence'

const bridge = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: { getStepEvidence: bridge.get } } }))
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
