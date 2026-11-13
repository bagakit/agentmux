import { describe, expect, it } from 'vitest'
import { parseBrowserTaskControlResult } from '../src/browser-task-control.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'

const run = (extra: Record<string, unknown> = {}) => ({
  id: 'original-run', assetId: 'original-asset', version: 1, browserId: 'original-browser', nextStep: 2, status: 'failed',
  operationIds: ['operation-check', 'operation-next'],
  stepExecutions: [{ stepId: 'check', operationId: 'operation-check' }, { stepId: 'next', operationId: 'operation-next' }],
  startedAt: 1, updatedAt: 2, warning: 'Task reached the end of its path with failed steps.', ...extra
})
const parse = (value: unknown) => parseBrowserTaskControlResult('browser.task.run', { run: value })

describe('browser.task run carries recorded failed steps', () => {
  it('keeps failedSteps bound to the executed operation through the public result codec', () => {
    const result = parse(run({ failedSteps: [{ stepId: 'check', operationId: 'operation-check' }] }))
    expect(result).toEqual({ operation: 'browser.task.run', run: expect.objectContaining({ status: 'failed', failedSteps: [{ stepId: 'check', operationId: 'operation-check' }] }) })
  })

  it('keeps runs without the field unchanged', () => {
    expect(parse(run())).not.toHaveProperty('run.failedSteps')
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['an operation of another step', { failedSteps: [{ stepId: 'check', operationId: 'operation-next' }] }, 'not bound to its executed operation'],
    ['an operation outside the run', { failedSteps: [{ stepId: 'check', operationId: 'operation-elsewhere' }] }, 'not bound to its executed operation'],
    ['a duplicated step', { failedSteps: [{ stepId: 'check', operationId: 'operation-check' }, { stepId: 'check', operationId: 'operation-check' }] }, 'identity is duplicated'],
    ['a completed run that recorded a failure', { status: 'completed', failedSteps: [{ stepId: 'check', operationId: 'operation-check' }] }, 'cannot be completed']
  ])('rejects %s', (_name, extra, reason) => {
    expect(() => parse(run(extra))).toThrow(reason)
  })

  it('documents the testing steps and their failure semantics in browser task help', () => {
    const help = agentMuxCommandHelp('browser.task')
    for (const phrase of ['`wait`', '`assert`', '`press`', '`hover`', '`scroll`', '`retry` 0–3', '`onFail` stop, continue or goto', '`failedSteps`', 'never `completed`', 'stopped and unknown results are not handled']) expect(help).toContain(phrase)
  })
})
