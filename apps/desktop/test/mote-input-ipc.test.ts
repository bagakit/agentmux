import { expect, it, vi } from 'vitest'
import ts from 'typescript'
import mainSource from '../src/main/ipc.ts?raw'
import preloadSource from '../src/preload/index.ts?raw'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'

// Execute the actual registered callbacks and preload entries, including the
// return after PMO confirmation. A wrapper-only test cannot detect a lost return.
function callback(source: string, select: (node: ts.Node) => ts.Expression | undefined, dependencies: Record<string, unknown>) {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => { const item = select(node); if (item) found.push(item); ts.forEachChild(node, visit) }
  visit(ast)
  expect(found).toHaveLength(1)
  const compiled = ts.transpileModule(`const callback = ${found[0]!.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return new Function(...Object.keys(dependencies), `${compiled}; return callback`)(...Object.values(dependencies)) as (...args: any[]) => any
}
function handler(channel: string, dependencies: Record<string, unknown>) {
  return callback(mainSource, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'handleWithEvent' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text === channel ? node.arguments[1] : undefined, dependencies)
}
function preload(name: string, invoke: (...args: any[]) => Promise<unknown>) {
  return callback(preloadSource, node => ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) &&
    node.name.text === name ? node.initializer : undefined, { ipcRenderer: { invoke } })
}

const session = { kind: 'agent', hostId: 'original-host', agentSessionId: 'member', run: { runId: 'original-run' } }
const source = { spaceId: 'mote', zoneId: 'zone', tabId: 'member-tab', regionId: 'member-region' }
const reference = { moteObservationId: 'original-observation', inputKey: { kind: 'prompt', agentSessionId: session.agentSessionId,
  expectedRun: session.run, submissionId: 'original-operation' } }

it('returns the original lightweight reference across the actual exact-condition Main and preload callbacks after PMO confirmation', async () => {
  const order: string[] = [], frame = {}, goalPmo = { goalId: 'goal' }, condition = { expectedRun: session.run, afterSubmissionId: null }
  const submitPrompt = vi.fn(async () => { order.push('submit'); return structuredClone(reference) })
  const confirmPmoParticipation = vi.fn(async () => { order.push('confirm') })
  const accept = handler('sessions:submitPrompt', {
    sessionInputWriteResult, args: { runtime: { submitPrompt, inspectGoalAttention: async () => null,
      agentCreation: async () => ({ agentSessionId: session.agentSessionId }) } }, contents: frame,
    pauseUserProgress: vi.fn(), pmoGoal: vi.fn(), goalRoleInputNote: (note: string) => note,
    preparePublicUserProfile: () => undefined, config: { profile: {} }, confirmPmoParticipation
  })
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    expect(channel).toBe('sessions:submitPrompt')
    return structuredClone(await accept({ sender: frame }, ...structuredClone(args)))
  })
  const result = unwrapSessionInputWriteResult(await preload('submitPrompt', invoke)(session, 'exact human input',
    'original-operation', condition, { moteSource: source }, true, 'original guide', 'message-tool', undefined, goalPmo))
  expect(result).toEqual(reference)
  expect(result).not.toHaveProperty('status')
  expect(order).toEqual(['submit', 'confirm'])
  expect(submitPrompt).toHaveBeenCalledExactlyOnceWith(session, 'exact human input', 'original-operation', condition,
    undefined, { moteSource: source }, true, 'original guide', 'message-tool', undefined, undefined, undefined)
  expect(confirmPmoParticipation).toHaveBeenCalledExactlyOnceWith(goalPmo, session, 'original-operation', 'prompt-input')
})

it('keeps the original manual receipt and Mote source through the same production callbacks', async () => {
  const receipt = { key: reference.inputKey, status: 'waiting', moteObservationId: reference.moteObservationId }
  const submitPrompt = vi.fn(async () => receipt), frame = {}
  const accept = handler('sessions:submitPrompt', { sessionInputWriteResult, args: { runtime: { submitPrompt } }, contents: frame,
    pauseUserProgress: vi.fn(), preparePublicUserProfile: () => undefined, config: { profile: {} } })
  const send = preload('submitPrompt', async (_channel, ...args) => structuredClone(await accept({ sender: frame }, ...args)))
  const condition = { expectedRun: session.run, admissionIntent: { kind: 'manual-actor' } }
  expect(unwrapSessionInputWriteResult(await send(session, 'human input', 'original-operation', condition,
    { execution: 'immediate', moteSource: source }, true))).toEqual(receipt)
  expect(submitPrompt).toHaveBeenCalledExactlyOnceWith(session, 'human input', 'original-operation', condition,
    undefined, { execution: 'immediate', moteSource: source }, true, undefined, undefined, undefined, undefined, undefined)
})

it('reads the exact original observation through the registered trusted IPC without submitting or redirecting it', async () => {
  const frame = {}, inspectMoteInput = vi.fn(async () => ({ status: 'unknown', observationId: reference.moteObservationId }))
  const accept = handler('sessions:inspectMoteInput', { args: { runtime: { inspectMoteInput } } })
  const read = preload('inspectMoteInput', async (channel, ...args) => {
    expect(channel).toBe('sessions:inspectMoteInput'); return structuredClone(await accept({ sender: frame }, ...args))
  })
  const original = { hostId: session.hostId, agentSessionId: session.agentSessionId }
  expect(await read(original, reference.moteObservationId)).toEqual({ status: 'unknown', observationId: reference.moteObservationId })
  expect(inspectMoteInput).toHaveBeenCalledExactlyOnceWith(original, reference.moteObservationId)
})
