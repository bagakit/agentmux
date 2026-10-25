import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, validateTests, validateNative, validateSummary } from '../scripts/verify-cross-host-execution.mjs'

test('the verification entry rejects ambiguous flags and a missing output value', () => {
  assert.deepEqual(parseArgs(['--mutations', '--plan']), { mutations: true, plan: true, output: undefined })
  for (const args of [['--mutations', '--mutations'], ['--unknown'], ['--output'], ['--output', '--plan']]) assert.throws(() => parseArgs(args))
})
test('empty, skipped and collection-failure test reports cannot certify consumers', () => {
  const good = { success: true, numTotalTests: 1, numPassedTests: 1, testResults: [{ assertionResults: [{ status: 'passed' }] }] }
  validateTests(good)
  for (const bad of [{}, { ...good, numTotalTests: 0 }, { ...good, testResults: [] },
    { ...good, testResults: [{ assertionResults: [{ status: 'pending' }] }] }]) assert.throws(() => validateTests(bad))
  assert.throws(() => validateTests({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: [{ assertionResults: [] }] }, true))
  validateTests({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: [{ assertionResults: [{ status: 'failed', failureMessages: ['AssertionError: original operation repeated'] }] }] }, true)
  validateTests({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: [{ assertionResults: [{ status: 'failed', failureMessages: ['Error: promise resolved "undefined" instead of rejecting\n at _Assertion.__VITEST_REJECTS__'] }] }] }, true)
  assert.throws(() => validateTests({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: [{ assertionResults: [{ status: 'failed', failureMessages: ['TypeError: unexpected missing fixture field'] }] }] }, true))
})
test('native success requires actual private evidence and no unhandled errors', () => {
  validateNative('verify-execution-binding', { passed: true, evidence: '/private/test-owned', errors: [] })
  for (const bad of [{ passed: true }, { passed: true, evidence: '/private/test-owned', errors: ['lost reply'] }]) assert.throws(() => validateNative('verify-execution-binding', bad))
  assert.throws(() => validateNative('verify-native-execution-helpers', { actualMachines: 1, commandOnResource: true }))
})
test('a generic success cannot substitute for original native identity and relay authorization', () => {
  const summary = { actualMachines: 1, originalCoreSession: 'sid', nativeConversationId: 'native', firstRun: { runId: 'first' },
    resumedRun: 'second', helperRuns: ['frontend', 'executor'], originalContextRetained: true, originalEffectCount: 1, errors: [],
    agentControl: { originalWhoami: 'sid', resumedWhoami: 'sid', callerlessRejected: true, userOnlyRejected: true,
      ownerChangedRouteUnavailable: true, nativeToolsRetained: true },
    ownerRestartEvidence: { previousOwner: 'old', currentOwner: 'new', runId: 'second', nativeInstanceId: 'original-runtime' } }
  validateSummary('verify-native-agent-control', summary)
  for (const bad of [{ ...summary, ownerRestartEvidence: { ...summary.ownerRestartEvidence, runId: 'first' } }, { ...summary, originalEffectCount: 2 }, { ...summary, resumedRun: 'first' },
    { ...summary, agentControl: { ...summary.agentControl, resumedWhoami: 'replacement' } },
    { ...summary, ownerRestartEvidence: { ...summary.ownerRestartEvidence, currentOwner: 'old' } }]) assert.throws(() => validateSummary('verify-native-agent-control', bad))
})
