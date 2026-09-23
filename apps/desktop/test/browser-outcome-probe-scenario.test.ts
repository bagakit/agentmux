import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { auditFieldOperation, auditPublicCompletion, numberCondition, outcomeFixture, readRecordedOutcome } from '../scripts/browser-outcome-probe-scenario.mjs'

// Source-only tests of the scenario's actual emitted reads and rejection oracles.
// This transport deliberately has no Desktop, Main manager or native input.
const browserId = 'browser-one', operationId = 'operation-one', pageUrl = 'http://127.0.0.1:9876/a'
const field = { key: 'result', type: 'number', source: { selector: '#verified-number', read: 'text' } }
function sample() {
  const context = { workspaceId: 'workspace-one', browserId, operationId, navigationId: 'navigation-one' }
  const source = { ...context, url: pageUrl, documentUrl: pageUrl, document: 'document-one', scope: { kind: 'page' } }
  const document = { schema: 'browser-structured-output.v1', request: { fields: [field] }, source,
    fields: [{ ...field, status: 'observed', value: 0 }], work: { reads: 1, visitedElements: 7 } }
  const bytes = Buffer.from(JSON.stringify(document))
  const artifact = { ...context, kind: 'browser-result-artifact', id: 'artifact-one', format: 'json',
    byteLength: bytes.length, capturedAt: 1, maxReadBytes: 65_536 }
  const reference = { id: 'evidence-one', operationId, browserId, navigationId: context.navigationId,
    sequence: 1, kind: 'structured-output', capturedAt: 1, byteLength: 900 }
  const criterion = { kind: 'field-equals', key: 'result', expected: 0 }
  const evaluation = { context, status: 'passed', conditions: [{ criterion, status: 'passed', reason: 'The field equals the declared value.' }] }
  const actual = { id: operationId, browserId, phase: 'completed', startedAt: 1,
    steps: [{ sequence: 1, method: 'extractStructured', status: 'completed', evidence: [reference] }],
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

// A Source-only keyboard model: arrows highlight a pending choice and Enter commits.
// It runs the actual emitted readonly expressions; it cannot prove macOS native input.
function keyboardTransport(initial: 'string' | 'number' | 'boolean', commit = true) {
  const window = new Window({ url: pageUrl })
  window.document.body.innerHTML = `<section class="browser-surface"><input aria-label="Browser address" value="${pageUrl}">
    <details class="browser-outcome-criteria"><label>CSS selector<input></label>
    <label>Value type<select><option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option></select></label>
    <label>Equals<input></label></details></section>`
  const select = window.document.querySelector('select') as HTMLSelectElement
  select.value = initial // Model setup only; the scenario never assigns the select.
  const sends: Array<{ type: string; key: string | undefined }> = []
  const reads: string[] = []
  const selections: Array<{ before: { value: string }; afterArrow: { value: string }; afterCommit: { value: string } }> = []
  let pending: string | undefined
  const ctx = { pageUrl, receipt: { browserOutcome: { numberSelections: selections } },
    selectors: (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
    click: async (_cdp: unknown, expression: string) => {
      const targets = window.eval(expression) as HTMLInputElement[]
      expect(targets).toHaveLength(1)
      expect(targets[0]!.tagName).toBe('INPUT')
      targets[0]!.focus() // Simulate the existing input sender, not a probe actuator.
    },
    probe: { cdp: {
      evaluate: async (expression: string) => { reads.push(expression); return window.eval(expression) },
      call: async (method: string, input: { type?: string; key?: string; text?: string }) => {
        if (method === 'Input.insertText') (window.document.activeElement as HTMLInputElement).value = input.text!
        else {
          expect(method).toBe('Input.dispatchKeyEvent')
          sends.push({ type: input.type!, key: input.key })
          if (input.type === 'keyDown' && input.key === 'Tab') select.focus()
          if (input.type === 'keyDown' && (input.key === 'ArrowDown' || input.key === 'ArrowUp')) pending = 'number'
          if (input.type === 'keyDown' && input.key === 'Enter' && pending && commit) select.value = pending
        }
      }
    } }
  }
  return { ctx, select, sends, reads, close: () => window.happyDOM.cancelAsync() }
}

describe('completion scenario source oracles, without launching a Desktop', () => {
  it.each(['string', 'boolean', 'number'] as const)('commits the actual %s starting type with one bounded keyboard path', async initial => {
    const model = keyboardTransport(initial)
    try {
      await numberCondition(model.ctx)
      const arrow = initial === 'string' ? 'ArrowDown' : 'ArrowUp'
      const choiceKeys = model.sends.filter(send => ['Tab', 'ArrowUp', 'ArrowDown', 'Enter'].includes(send.key!))
      expect(choiceKeys).toEqual(initial === 'number'
        ? [{ type: 'keyDown', key: 'Tab' }, { type: 'keyUp', key: 'Tab' }]
        : ['Tab', arrow, 'Enter'].flatMap(key => [{ type: 'keyDown', key }, { type: 'keyUp', key }]))
      expect(model.ctx.receipt.browserOutcome.numberSelections).toHaveLength(1)
      expect(model.ctx.receipt.browserOutcome.numberSelections[0]).toMatchObject({
        before: { value: initial }, afterArrow: { value: initial }, afterCommit: { value: 'number' }
      })
      expect(model.select.value).toBe('number')
      expect(model.reads.length).toBeGreaterThan(0)
      expect(model.reads.join('\n')).not.toMatch(/\.(?:value|selectedIndex)\s*=|\.focus\(/)
    } finally { model.close() }
  })

  it('preserves the original numeric gate when the real commit has not changed its value', async () => {
    const model = keyboardTransport('string', false)
    try {
      await expect(numberCondition(model.ctx)).rejects.toThrow('Actual keyboard input commits the numeric type')
      expect(model.select.value).toBe('string')
      expect(model.sends.filter(send => send.key === 'Enter')).toEqual([
        { type: 'keyDown', key: 'Enter' }, { type: 'keyUp', key: 'Enter' }
      ])
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
    const result = await readRecordedOutcome(ctx, data.actual)
    expect(result.document).toEqual(data.document)
    expect(result.sha256).toBe(createHash('sha256').update(data.bytes).digest('hex'))
    expect(result.chunks).toEqual([{ offset: 0, returnedBytes: data.bytes.length, nextOffset: null }])
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

  it('rejects complete bytes from another field request instead of trusting the zero preview', async () => {
    const data = sample()
    const wrong = { ...data.document, request: { fields: [{ ...field, source: { selector: '#another-field', read: 'text' } }] } }
    const bytes = Buffer.from(JSON.stringify(wrong))
    data.chunk.data = bytes.toString('base64'); data.chunk.returnedBytes = bytes.length; data.chunk.totalBytes = bytes.length
    data.chunk.reference.byteLength = bytes.length
    const { ctx } = transport(data)
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })

  it('rejects an additional producer during a purported readonly evidence read', async () => {
    const data = sample(), { ctx } = transport(data, { extraHistoryAfterRead: true })
    await expect(readRecordedOutcome(ctx, data.actual)).rejects.toThrow()
  })
})
