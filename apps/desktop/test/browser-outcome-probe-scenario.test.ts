import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Window, type HTMLButtonElement, type HTMLInputElement } from 'happy-dom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMuxControlServer, requestAgentMuxControl } from '../../../packages/core/src/control-host'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest, type AgentMuxControlSuccessReceipt } from '../../../packages/core/src/control'
import { projectBrowserControlResult } from '../src/main/browser-completion-control'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import { auditFieldOperation, auditPublicCompletion, numberCondition, outcomeFixture, publicFacts, readRecordedOutcome } from '../scripts/browser-outcome-probe-scenario.mjs'

// Source tests of the scenario's actual emitted reads and rejection oracles.
// Only the public consumer case starts the real Core control socket; these tests
// do not launch a Desktop or send macOS native input.
const browserId = 'browser-one', operationId = 'operation-one', pageUrl = 'http://127.0.0.1:9876/a'
const field = { key: 'result', type: 'number' as const, source: { selector: '#verified-number', read: 'text' as const } }
function sample() {
  const context = { workspaceId: 'workspace-one', browserId, operationId, navigationId: 'navigation-one' }
  const source = { ...context, url: pageUrl, documentUrl: pageUrl, document: 'document-one', scope: { kind: 'page' } }
  const document = { schema: 'browser-structured-output.v1', request: { fields: [field] }, source,
    fields: [{ ...field, status: 'observed', value: 0 }], work: { reads: 1, visitedElements: 7 } }
  const bytes = Buffer.from(JSON.stringify(document))
  const artifact = { ...context, kind: 'browser-result-artifact', id: 'artifact-one', format: 'json',
    byteLength: bytes.length, capturedAt: 1, maxReadBytes: 65_536 }
  const reference = { id: 'evidence-one', operationId, browserId, navigationId: context.navigationId,
    sequence: 1, kind: 'structured-output' as const, capturedAt: 1, byteLength: 900 }
  const criterion = { kind: 'field-equals' as const, key: 'result', expected: 0 }
  const evaluation = { context, status: 'passed' as const, conditions: [{ criterion, status: 'passed' as const, reason: 'The field equals the declared value.' }] }
  const actual = { id: operationId, browserId, phase: 'completed' as const, startedAt: 1,
    operator: { id: 'person', name: 'Person' }, summary: 'Check the declared field', url: pageUrl,
    steps: [{ sequence: 1, method: 'extractStructured', label: 'Observe declared field', startedAt: 1,
      status: 'completed' as const, evidence: [reference] }],
    outcome: { registration: { context, criteria: [{ ...criterion,
      producer: { operationId, navigationId: context.navigationId, sequence: 1, request: { fields: [field] } } }] }, evaluation } }
  const evidence = { operationId, sequence: 1, status: 'available', items: [{ reference,
    content: { kind: 'structured-output', receipt: { kind: 'browser-structured-output', status: 'complete',
      source, artifactStatus: 'available', artifact, fields: [{ ...field, status: 'observed', inline: true, value: 0 }], work: document.work } } }] }
  const chunk = { reference: artifact, encoding: 'base64', data: bytes.toString('base64'),
    offset: 0, returnedBytes: bytes.length, totalBytes: bytes.length, nextOffset: null }
  const publicOperation = { ...actual, completion: evaluation } as Record<string, unknown>
  delete publicOperation.outcome
  return { actual, evidence, chunk, document, bytes, publicOperation }
}
function transport(data: ReturnType<typeof sample>, options: { extraHistoryAfterRead?: boolean } = {}) {
  const calls: string[] = []
  let read = false
  const browser = {
    listOperationHistory: async () => read && options.extraHistoryAfterRead ? [data.actual, { id: 'extra-producer', browserId }] : [data.actual],
    getStepEvidence: async (id: string, sequence: number) => { expect([id, sequence]).toEqual([operationId, 1]); return data.evidence },
    readStepResult: async (id: string, sequence: number, options: unknown) => {
      expect([id, sequence, options]).toEqual([operationId, 1, { offset: 0, maxBytes: 65_536 }])
      read = true
      return data.chunk
    }
  }
  const ctx = { browserId, pageUrl, probe: { cdp: { evaluate: async (expression: string) => {
    calls.push(expression)
    return await runInNewContext(expression, { window: { agentmux: { browser } } })
  } } } }
  return { ctx, calls }
}
function replaceCompleteDocument(data: ReturnType<typeof sample>, document: ReturnType<typeof sample>['document']) {
  const bytes = Buffer.from(JSON.stringify(document))
  data.chunk.data = bytes.toString('base64'); data.chunk.returnedBytes = bytes.length; data.chunk.totalBytes = bytes.length
  data.chunk.reference.byteLength = bytes.length
}

// Source-only standard radio keyboard model, using production rendered markup.
// It executes the emitted readonly reads, and cannot prove Native input defaults.
function keyboardTransport(initial: 'string' | 'number' | 'boolean', commit = true) {
  const window = new Window({ url: pageUrl })
  window.document.body.innerHTML = `<section class="browser-surface"><input aria-label="Browser address" value="${pageUrl}">
    ${renderToStaticMarkup(createElement(BrowserOutcomeCriteria, { onRun: async () => {} }))}</section>`
  const radios = [...window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  for (const radio of radios) radio.checked = radio.value === initial // Model setup only, outside the scenario.
  const sends: Array<{ type: string; key: string | undefined }> = []
  const reads: string[] = []
  const selections: Array<{ before: { value: string }; afterArrow: { value: string }; afterCommit: { value: string } }> = []
  const ctx = { pageUrl, receipt: { browserOutcome: { numberSelections: selections } },
    selectors: (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
    click: async (_cdp: unknown, expression: string) => {
      const targets = window.eval(expression) as HTMLInputElement[]
      expect(targets).toHaveLength(1)
      expect(targets[0]!.tagName).toBe('INPUT')
      targets[0]!.focus() // Simulate the existing input sender, not a probe actuator.
    },
    probe: { cdp: {
      evaluate: async (expression: string) => { reads.push(expression); return JSON.parse(JSON.stringify(window.eval(expression))) },
      call: async (method: string, input: { type?: string; key?: string; text?: string }) => {
        if (method === 'Input.insertText') (window.document.activeElement as HTMLInputElement).value = input.text!
        else {
          expect(method).toBe('Input.dispatchKeyEvent')
          sends.push({ type: input.type!, key: input.key })
          if (input.type === 'keyDown' && input.key === 'Tab') radios.find(radio => radio.checked)!.focus()
          if (input.type === 'keyDown' && (input.key === 'ArrowRight' || input.key === 'ArrowLeft') && commit) {
            const number = radios.find(radio => radio.value === 'number')!
            number.click(); number.focus()
          }
        }
      }
    } }
  }
  return { ctx, window, radios, sends, reads, close: () => window.happyDOM.cancelAsync() }
}

describe('completion scenario source oracles, without launching a Desktop', () => {
  it('consumes result.operations and result.runOperation from the actual production socket SuccessReceipt', async () => {
    const data = sample(), root = await mkdtemp(join(tmpdir(), 'amx-t020-'))
    const socket = join(root, 'control.sock'), requests: AgentMuxControlRequest[] = [], receipts: AgentMuxControlSuccessReceipt[] = []
    const server = new AgentMuxControlServer({ async execute(request) {
      requests.push(request)
      if (request.operation === 'browser.history') return projectBrowserControlResult({ operation: request.operation, operations: [data.actual] })
      if (request.operation === 'browser.operation') return projectBrowserControlResult({ operation: request.operation, runOperation: data.actual })
      throw new Error('Unexpected public consumer request')
    } }, socket)
    try {
      await server.start()
      const ctx = { browserId, requestControl: async (fields: Record<string, unknown>) => {
        const receipt = await requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
          requestId: randomUUID(), ...fields } as AgentMuxControlRequest, socket)
        receipts.push(receipt)
        return receipt
      } }
      await expect(publicFacts(ctx, data.actual)).resolves.toEqual({ history: data.publicOperation, operation: data.publicOperation })
      expect(requests.map(request => request.operation)).toEqual(['browser.history', 'browser.operation'])
      expect(receipts.map(receipt => [receipt.ok, receipt.operation, Object.keys(receipt.result)])).toEqual([
        [true, 'browser.history', ['operations']], [true, 'browser.operation', ['runOperation']]
      ])
      expect(Object.hasOwn(receipts[0]!, 'operations')).toBe(false)
      expect(Object.hasOwn(receipts[1]!, 'runOperation')).toBe(false)
      expect(JSON.stringify(receipts)).not.toContain('registration')
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['string', 'boolean', 'number'] as const)('commits the actual %s starting type with one bounded keyboard path', async initial => {
    const model = keyboardTransport(initial)
    try {
      await numberCondition(model.ctx)
      const arrow = initial === 'string' ? 'ArrowRight' : 'ArrowLeft'
      const choiceKeys = model.sends.filter(send => ['Tab', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(send.key!))
      expect(choiceKeys).toEqual(initial === 'number'
        ? [{ type: 'keyDown', key: 'Tab' }, { type: 'keyUp', key: 'Tab' }]
        : ['Tab', arrow].flatMap(key => [{ type: 'keyDown', key }, { type: 'keyUp', key }]))
      expect(model.ctx.receipt.browserOutcome.numberSelections).toHaveLength(1)
      expect(model.ctx.receipt.browserOutcome.numberSelections[0]).toMatchObject({
        before: { value: initial }, afterArrow: { value: 'number' }, afterCommit: { value: 'number' }
      })
      expect(model.radios.filter(radio => radio.checked).map(radio => radio.value)).toEqual(['number'])
      expect([...model.window.document.querySelectorAll('label')].find(label => label.firstChild?.textContent?.trim() === 'Equals')?.querySelector('input')?.value).toBe('0')
      expect([...model.window.document.querySelectorAll('label')].find(label => label.firstChild?.textContent?.trim() === 'CSS selector')?.querySelector('input')?.value).toBe('#verified-number')
      expect(model.reads.length).toBeGreaterThan(0)
      expect(model.reads.join('\n')).not.toMatch(/\.(?:value|checked|selectedIndex)\s*=|\.focus\(/)
    } finally { model.close() }
  })

  it('preserves the original numeric gate when the real commit has not changed its value', async () => {
    const model = keyboardTransport('string', false)
    try {
      await expect(numberCondition(model.ctx)).rejects.toThrow('Actual keyboard input selects the numeric radio')
      expect(model.radios.filter(radio => radio.checked).map(radio => radio.value)).toEqual(['string'])
      expect(model.sends.filter(send => send.key === 'Enter')).toEqual([])
      expect(model.ctx.receipt.browserOutcome.numberSelections).toHaveLength(1)
      expect(model.ctx.receipt.browserOutcome.numberSelections[0]?.afterCommit.value).toBe('string')
    } finally { model.close() }
  })

  it('serves generic zero, false and empty fields; a DOM click stays untrusted', () => {
    const html = outcomeFixture('/a'), window = new Window({ url: pageUrl })
    const script = /<script>([\s\S]+)<\/script>/.exec(html)
    expect(script).not.toBeNull()
    window.document.body.innerHTML = html.replace(script![0], '')
    window.eval(script![1]!)
    expect(window.document.querySelector('#verified-number')?.textContent).toBe('0')
    expect((window.document.querySelector('#verified-boolean') as HTMLInputElement).checked).toBe(false)
    expect(window.document.querySelector('#verified-text')?.textContent).toBe('')
    ;(window.document.querySelector('#verified-action') as HTMLButtonElement).click()
    expect(window.eval('({actions:outcomePageActions,clicks:demoTrusted.click})')).toEqual({ actions: 1, clicks: 0 })
    expect(outcomeFixture('/b')).toContain('id="verified-number"')
    window.happyDOM.cancelAsync()
  })

  it('joins the one completed producer, original declaration and numeric zero result', () => {
    const { actual } = sample()
    expect(auditFieldOperation(actual, browserId, 'passed')).toEqual(actual.outcome.evaluation)
    const foreign = structuredClone(actual)
    foreign.outcome.registration.criteria[0]!.producer.operationId = 'foreign-producer'
    expect(() => auditFieldOperation(foreign, browserId, 'passed')).toThrow()
    const emptySteps = structuredClone(actual)
    emptySteps.steps = []
    expect(() => auditFieldOperation(emptySteps, browserId, 'passed')).toThrow()
  })

  it('requires the public completion and exact operation identity, without raw Main provenance', () => {
    const { actual, publicOperation } = sample()
    expect(() => auditPublicCompletion(publicOperation, actual)).not.toThrow()
    expect(() => auditPublicCompletion({ ...publicOperation, completion: undefined }, actual)).toThrow()
    expect(() => auditPublicCompletion({ ...publicOperation, id: 'foreign-operation' }, actual)).toThrow()
    expect(() => auditPublicCompletion({ ...publicOperation, outcome: actual.outcome }, actual)).toThrow()
  })

  it('executes the actual emitted evidence/chunk/history reads and consumes exact bounded bytes', async () => {
    const data = sample(), { ctx, calls } = transport(data)
    const readCost = { metadataBytes: 123, payloadBytes: data.bytes.length }; Object.assign(data.chunk, { readCost })
    const result = await readRecordedOutcome(ctx, data.actual)
    expect(result.document).toEqual(data.document)
    expect(result.sha256).toBe(createHash('sha256').update(data.bytes).digest('hex'))
    expect(result.chunks).toEqual([{ offset: 0, returnedBytes: data.bytes.length, nextOffset: null, readCost }])
    expect(calls).toHaveLength(4)
    expect(calls.join('\n')).toContain('readStepResult')
    expect(calls.join('\n')).not.toContain('runScript')
  })

  it('rejects a foreign artifact returned by the actual emitted chunk read', async () => {
    const data = sample()
    data.chunk.reference = { ...data.chunk.reference, id: 'foreign-artifact' }
    const { ctx } = transport(data)
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })

  it('requires the original evidence reference retained by the completed extraction step', async () => {
    const data = sample()
    data.evidence.items[0]!.reference = { ...data.evidence.items[0]!.reference, id: 'unlinked-evidence' }
    const { ctx } = transport(data)
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })

  it('rejects complete bytes from another source document even when the request and numeric preview match', async () => {
    const data = sample()
    replaceCompleteDocument(data, { ...data.document, source: { ...data.document.source, document: 'another-document' } })
    const { ctx } = transport(data)
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })

  it('rejects complete bytes with a different numeric value instead of trusting the zero preview', async () => {
    const data = sample()
    replaceCompleteDocument(data, { ...data.document, fields: [{ ...data.document.fields[0]!, value: 1 }] })
    const { ctx } = transport(data)
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })

  it('rejects complete bytes from another field request instead of trusting the zero preview', async () => {
    const data = sample()
    const wrong = { ...data.document, request: { fields: [{ ...field, source: { selector: '#another-field', read: 'text' as const } }] } }
    replaceCompleteDocument(data, wrong)
    const { ctx } = transport(data)
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })

  it('rejects an additional producer during a purported readonly evidence read', async () => {
    const data = sample(), { ctx } = transport(data, { extraHistoryAfterRead: true })
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })
})
