import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteTarget, toolSceneOptions } from '../scripts/fixtures/space-agent-cli/tool-remote.mjs'
const authorization = () => ({ schema: 'agentmux.cross-host-target-authorization.v1', source: { role: 'user', kind: 'question-reply', answer: 'Use this private test Host', scope: 'Isolated two-machine test owners' },
  remote: { sshTarget: 'test@example.invalid', verifiedNodePath: '/private/node' },
  executionCandidate: { schema: 'agentmux.cross-host-installed-candidate.v1', sourceCommit: 'a'.repeat(40), scopeId: 'private-test-owner',
    candidateReceipt: '/private/candidate.json', remote: { installedRoot: '/private/install', packageRoot: '/private/install/core', nodePath: '/private/node',
      codexDirectory: '/private/install/codex', profileRoot: '/private/profile', command: '/private/install/amux', endpoint: { transport: 'ssh', host: 'example.invalid', user: 'test' } } } })
test('the Desktop remote scene consumes the exact original authorized SSH target', () => {
  const actual = remoteTarget(authorization())
  assert.equal(actual.target, 'test@example.invalid'); assert.equal(actual.endpoint.transport, 'ssh')
})
test('a local endpoint, changed target, unsafe path or unqualified candidate cannot become remote evidence', () => {
  for (const breakInput of [value => { value.executionCandidate.remote.endpoint.transport = 'unix' },
    value => { value.executionCandidate.remote.endpoint.host = 'another.invalid' }, value => { value.executionCandidate.remote.nodePath = '/another/node' },
    value => { value.executionCandidate.remote.packageRoot = '/private/foreign/core' }, value => { value.executionCandidate.remote.installedRoot = '/tmp' },
    value => { value.source.role = 'assistant' }, value => { delete value.source.scope }, value => { value.executionCandidate.sourceCommit = 'unconfirmed' },
    value => { value.executionCandidate.remote.command = '/private/install/../outside' }]) {
    const input = authorization(); breakInput(input); assert.throws(() => remoteTarget(input))
  }
})

test('direction flags require one exact authorized target and both keeps two explicit directions', () => {
  assert.deepEqual(toolSceneOptions(['--tool-workspace', '--remote-target', '/private/target.json', '--direction', 'both']), {
    toolMode: true, remoteReceipt: '/private/target.json', direction: 'both' })
  for (const direction of ['local-agent', 'remote-agent']) assert.equal(toolSceneOptions(['--remote-target', '/private/target.json', '--tool-workspace', '--direction', direction]).direction, direction)
  assert.deepEqual(toolSceneOptions(['--tool-workspace']), { toolMode: true, remoteReceipt: undefined, direction: 'remote-agent' })
  for (const args of [['--direction', 'both'], ['--remote-target', '/private/target.json'], ['--tool-workspace', '--remote-target'],
    ['--tool-workspace', '--tool-workspace'], ['--tool-workspace', '--unknown'], ['--tool-workspace', '--remote-target', '/private/target.json', '--direction', 'sideways']]) {
    assert.throws(() => toolSceneOptions(args))
  }
})
