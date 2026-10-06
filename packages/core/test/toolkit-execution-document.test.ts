import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { fixturePath } from './helpers/fixture-values.js'
import { parseToolkitResult, parseToolkitSnapshot, type ToolkitAdmission, type ToolkitConfirmedResult, type ToolkitResultDocument, type ToolkitScriptSnapshot, type ToolkitToolDefinition } from '../src/toolkit.js'

const definition: ToolkitToolDefinition = { id: 'document-tool', revision: 'revision', name: 'Document', icon: 'terminal', enabled: true,
  statusBar: 'icon', workspacePath: fixturePath('document-workspace'), script: 'textScript()', args: [], display: { script: 'displayScript()', args: [] } }
const document: ToolkitResultDocument = { schema: 'agentmux.toolkit.result.v1', summary: '工具', items: [], links: [{ label: 'Open', url: 'https://example.org/#complete-fragment' }], notice: '',
  agentCards: { fields: ['name', 'runId'], omittedItems: 0, items: [{ reference: { kind: 'run', hostId: 'local', runId: 'original-run' }, metrics: [{ label: 'CPU', value: '1' }] }] } }
const admission: ToolkitAdmission = { executionId: 'original-execution', invocationId: 'original-invocation', definition,
  expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'original-run' },
  startedAt: _newTailFixtureEpoch(0, 0, 1), text: 'diagnostic prefix\nJSON-looking text', state: 'running', reason: null }
const confirmed: ToolkitConfirmedResult = { ...admission, state: 'succeeded', endedAt: _newTailFixtureEpoch(0, 0, 2), exitCode: 0 }
const snapshot = (fact: ToolkitConfirmedResult): ToolkitScriptSnapshot => ({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id,
  definition, state: fact.state, reason: fact.reason, admission: null, latestConfirmed: fact, consumerCount: 0, sequence: 1,
  display: { state: fact.state, reason: fact.reason, admission: null, latestConfirmed: fact, sequence: 1 } })

describe('custom execution machine documents', () => {
  it.each(['absent', 'unavailable', 'complete'] as const)('round-trips %s documents through ordinary, display and public result parsing', kind => {
    const fact = kind === 'absent' ? confirmed : { ...confirmed, document: kind === 'unavailable' ? null : document }
    const value = snapshot(fact)
    const parsed = parseToolkitSnapshot(value) as ToolkitScriptSnapshot
    expect(parsed).toEqual(value)
    expect(parseToolkitResult('toolkit.get', { snapshot: value })).toEqual({ operation: 'toolkit.get', snapshot: value })
    expect(parseToolkitSnapshot({ ...value, state: 'running', admission: { ...admission, ...(kind === 'absent' ? {} : { document: fact.document }) } })).toMatchObject({ admission: { text: admission.text } })
    expect(Object.hasOwn(parsed.latestConfirmed!, 'document')).toBe(kind !== 'absent')
  })
  it('admits typed cards inside retained display results without applying arbitrary Settings nesting', () => {
    const value = snapshot({ ...confirmed, executionId: 'new-execution', document: null, reason: 'Original machine document is unavailable.' })
    value.display!.lastSucceeded = { ...confirmed, document }
    expect(parseToolkitSnapshot(value)).toEqual(value)
  })
  it.each([undefined, {}, 'JSON-looking text', { ...document, extra: true }, { ...document, links: [{ label: 'Bad', url: 'javascript:alert(1)' }] }])('rejects an explicitly invalid document without borrowing text', value => {
    expect(() => parseToolkitSnapshot(snapshot({ ...confirmed, document: value as ToolkitResultDocument }))).toThrow()
  })
  it('rejects getters and unknown wrapper fields before evaluating them', () => {
    const getter = () => { throw new Error('must not invoke') }
    const nested = Object.defineProperty({ ...confirmed }, 'document', { enumerable: true, get: getter })
    expect(() => parseToolkitSnapshot(snapshot(nested))).toThrowError('Settings resource JSON is invalid or exceeds its budget.')
    expect(() => parseToolkitSnapshot(snapshot({ ...confirmed, extra: true } as ToolkitConfirmedResult))).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(confirmed), display: { ...snapshot(confirmed).display, extra: true } })).toThrow()
  })
  it('does not admit a machine document without its original Run identity', () => {
    for (const result of [document, null]) expect(() => parseToolkitSnapshot({ ...snapshot(confirmed), state: 'unknown',
      admission: { ...admission, state: 'unknown', document: result, run: null } })).toThrow()
  })
})
