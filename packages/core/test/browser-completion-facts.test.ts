import { describe, expect, it } from 'vitest'
import { BROWSER_COMPLETION_UNAVAILABLE_WARNING, parseBrowserCompletionFacts, type AgentMuxBrowserCompletion } from '../src/browser-completion-facts.js'
import { AgentMuxError } from '../src/errors.js'

const owner = { operationId: 'operation-1', browserId: 'browser-1' }
const sample = (): AgentMuxBrowserCompletion => ({
  context: { workspaceId: 'workspace-1', ...owner, navigationId: 'navigation-1' },
  assetRun: { runId: 'run-1', assetId: 'asset-1', version: 2 }, status: 'passed',
  conditions: [
    { criterion: { kind: 'field-equals', key: 'total', expected: 0 }, status: 'passed', reason: 'The declared field matches.' },
    { criterion: { kind: 'download-readable', path: 'files/result.bin' }, status: 'passed', reason: 'The registered file is readable.' },
    { criterion: { kind: 'human-checkpoint', checkpointId: 'checkpoint-1' }, status: 'passed', reason: 'The existing owner recorded this event.' }
  ]
})
const invalid = (value: unknown, expected = owner) => {
  expect(() => parseBrowserCompletionFacts(value, expected)).toThrowError(AgentMuxError)
  try { parseBrowserCompletionFacts(value, expected) } catch (error) {
    expect((error as AgentMuxError).code).toBe('CONTROL_PROTOCOL_ERROR')
    expect((error as Error).message).not.toContain('private-raw-error')
  }
}
const accepted = (value: unknown, expected = owner): AgentMuxBrowserCompletion => {
  let parsed: AgentMuxBrowserCompletion | undefined
  expect(() => { parsed = parseBrowserCompletionFacts(value, expected) }).not.toThrow()
  expect(parsed).toBeDefined()
  return parsed!
}

describe('finite public Browser completion projection', () => {
  it('retains all three declared conditions, exact identities and selected version with copied results', () => {
    const value = sample(), parsed = accepted(value)
    expect(parsed).toEqual(value)
    expect(parsed.conditions).toHaveLength(3)
    expect(parsed.assetRun).toEqual({ runId: 'run-1', assetId: 'asset-1', version: 2 })
    parsed.conditions[0]!.reason = 'changed-copy'
    parsed.context.operationId = 'changed-copy'
    parsed.assetRun!.version = 3
    expect(value.conditions[0]!.reason).toBe('The declared field matches.')
    expect(value.context.operationId).toBe(owner.operationId)
    expect(value.assetRun!.version).toBe(2)
  })

  it('preserves zero, false and the empty string without truthiness defaults', () => {
    const value = sample()
    value.conditions = [0, false, ''].map(expected => ({ criterion: { kind: 'field-equals', key: 'actual-field', expected }, status: 'passed', reason: 'Matches the declared scalar.' }))
    expect(accepted(value).conditions.map(item => item.criterion)).toEqual([
      { kind: 'field-equals', key: 'actual-field', expected: 0 }, { kind: 'field-equals', key: 'actual-field', expected: false },
      { kind: 'field-equals', key: 'actual-field', expected: '' }
    ])
  })

  it('joins original operation and Browser instead of accepting foreign or historical packets', () => {
    invalid(sample(), { ...owner, operationId: 'evaluation-operation' })
    invalid(sample(), { ...owner, browserId: 'foreign-browser' })
    for (const key of ['browserId', 'operationId', 'navigationId', 'workspaceId']) {
      for (const bad of ['', ' ', 'self', 'line\nbreak']) invalid({ ...sample(), context: { ...sample().context, [key]: bad } })
    }
    invalid({ ...sample(), context: { ...sample().context, navigationId: undefined } })
    invalid({ ...sample(), context: { ...sample().context, workspaceId: undefined } })
    invalid({ ...sample(), context: { ...sample().context, navigationId: '界'.repeat(180) } })
  })

  it('keeps unavailable and not-met distinct; aggregate must agree with nonempty condition facts', () => {
    const value = sample()
    value.conditions[1]!.status = 'not-met'; value.status = 'not-met'
    expect(accepted(value).status).toBe('not-met')
    value.conditions[2]!.status = 'unavailable'; value.status = 'unavailable'; value.warning = 'Restore access; existing Browser work remains.'
    expect(accepted(value)).toEqual(value)
    for (const status of ['passed', 'not-met', 'completed', 'unknown']) invalid({ ...value, status })
    invalid({ ...sample(), status: 'unavailable' })
    invalid({ ...sample(), conditions: [] })
    invalid({ ...sample(), conditions: [], status: 'unavailable' })
    invalid({ ...sample(), conditions: Array.from({ length: 9 }, () => sample().conditions[0]!) })
    expect(accepted({ ...sample(), conditions: Array.from({ length: 8 }, () => sample().conditions[0]!) }).conditions).toHaveLength(8)
  })

  it('accepts an honest unknown Workspace without inventing one or changing status', () => {
    const value = sample(); value.context.workspaceId = null
    value.status = 'unavailable'; value.conditions[0]!.status = 'unavailable'
    expect(accepted(value)).toEqual(value)
  })

  it('requires an asset run for a determinate human condition while an independent field needs none', () => {
    const { assetRun: _assetRun, ...value } = sample()
    value.conditions = [sample().conditions[0]!]
    expect(accepted(value)).toEqual(value)
    invalid({ ...value, conditions: [sample().conditions[2]!] })
    invalid({ ...value, status: 'not-met', conditions: [{ ...sample().conditions[2]!, status: 'not-met' }] })
    value.conditions = [{ ...sample().conditions[2]!, status: 'unavailable' }]; value.status = 'unavailable'
    expect(accepted(value)).toEqual(value)
  })

  it('does not retain arbitrary requests, producer/raw result/error or approval capabilities at any level', () => {
    for (const extras of [{ request: {} }, { observed: 'private-raw-error' }, { approved: true }, { rawError: 'private-raw-error' }]) invalid({ ...sample(), ...extras })
    invalid({ ...sample(), context: { ...sample().context, sender: 'page' } })
    invalid({ ...sample(), assetRun: { ...sample().assetRun!, approved: true } })
    for (const extras of [{ producer: { operationId: 'foreign' } }, { actual: 'private-raw-error' }, { approved: true }]) {
      invalid({ ...sample(), conditions: [{ ...sample().conditions[0]!, ...extras }] })
    }
    invalid({ ...sample(), conditions: [{ ...sample().conditions[0]!, criterion: { kind: 'field-equals', key: 'field', expected: 0, request: {} } }] })
    invalid({ ...sample(), conditions: [{ ...sample().conditions[1]!, criterion: { kind: 'download-readable', path: 'result.bin', expected: true } }] })
    invalid({ ...sample(), conditions: [{ ...sample().conditions[2]!, criterion: { kind: 'human-checkpoint', checkpointId: 'check', approved: true } }] })
  })

  it('rejects unknown, missing or unbounded primitive fields and unsafe asset versions', () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) invalid({ ...sample(), assetRun: { ...sample().assetRun!, version } })
    for (const expected of [undefined, null, {}, [], NaN, Infinity, 'x'.repeat(16 * 1024 + 1)]) {
      invalid({ ...sample(), conditions: [{ ...sample().conditions[0]!, criterion: { kind: 'field-equals', key: 'field', expected } }] })
    }
    for (const criterion of [{ kind: 'arbitrary-json', key: 'field' }, { kind: 'field-equals', key: ' ', expected: 0 },
      { kind: 'download-readable', path: '' }, { kind: 'human-checkpoint', checkpointId: '' }]) {
      invalid({ ...sample(), conditions: [{ ...sample().conditions[0]!, criterion }] })
    }
    invalid({ ...sample(), conditions: [{ ...sample().conditions[0]!, status: 'complete' }] })
    invalid({ ...sample(), status: 'not-met', conditions: [{ ...sample().conditions[0]!, status: 'complete' }] })
    invalid({ ...sample(), conditions: [{ ...sample().conditions[0]!, reason: '' }] })
    invalid({ ...sample(), warning: 'x'.repeat(2049) })
  })

  it('enforces the total UTF-8 budget even though each primitive is within its own bound', () => {
    const value = sample()
    value.conditions = Array.from({ length: 3 }, (_, index) => ({ criterion: { kind: 'field-equals', key: `field-${index}`, expected: '界'.repeat(9000) }, status: 'passed', reason: 'Matches.' }))
    expect(JSON.stringify(value).length).toBeLessThan(64 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(64 * 1024)
    invalid(value)
  })

  it('supplies a shared unavailable notice without treating unreadable facts as a dead Browser', () => {
    expect(BROWSER_COMPLETION_UNAVAILABLE_WARNING).toContain('verification is unavailable')
    expect(BROWSER_COMPLETION_UNAVAILABLE_WARNING).toContain('Existing Browser work remains')
    invalid({ ...sample(), rawError: 'private-raw-error' })
  })
})
