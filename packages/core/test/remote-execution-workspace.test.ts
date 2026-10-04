import { fixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'

it('public CLI independently names the execution Workspace and local display split using canonical directions', async () => {
  const invocation = await parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'remote-configured', '--execution-workspace', 'remote-workspace',
    '--region', 'local-region', '--split', 'down', '--prompt', 'first task', '--operation-id', 'remote-operation'])
  expect(invocation.command.method).toBe('agent.open')
  expect(invocation.params).toMatchObject({ content: { kind: 'new-agent', executorId: 'remote-configured', executionWorkspaceId: 'remote-workspace', prompt: 'first task' },
    destination: { regionId: 'local-region', split: 'down' }, operationId: 'remote-operation', focus: false })
  const request = rpcControlRequest('agent.open', invocation.params)
  expect(request).toMatchObject({ operation: 'agent.open', requestId: 'remote-operation', content: { executionWorkspaceId: 'remote-workspace' }, destination: { regionId: 'local-region', split: 'down' } })
  expect(agentMuxCommandHelp('agent.open')).toContain('--execution-workspace')
  expect(agentMuxCommandHelp('agent.open')).not.toContain('--split below')
  for (const direction of ['above', 'below']) await expect(parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'x', '--region', 'r', '--split', direction])).rejects.toThrow()
})
it('execution Workspace is unavailable to fork, existing Session and new Zone creation in both public carriers', async () => {
  for (const args of [
    ['--session', 'existing'], ['--fork-from', 'parent', '--fork-source', fixturePath("not-read")],
    ['--executor', 'x', '--new-zone', '--project', 'p', '--directory', fixturePath("new")]
  ]) await expect(parseAgentMuxCliInvocation(['agent', 'open', ...args, '--execution-workspace', 'remote-workspace', '--region', 'r'])).rejects.toThrow()
  for (const content of [
    { kind: 'agent-session', agentSessionId: 'existing', executionWorkspaceId: 'remote' },
    { kind: 'fork-agent', source: {}, executionWorkspaceId: 'remote' }
  ]) expect(() => rpcControlRequest('agent.open', { content, destination: { regionId: 'r' }, focus: false })).toThrow()
  expect(() => rpcControlRequest('agent.open', { content: { kind: 'new-agent', executorId: 'x', executionWorkspaceId: 'remote' },
    destination: { spaceId: 'p', newZone: { kind: 'directory', projectId: 'p', path: fixturePath("new") } }, focus: false })).toThrow()
})
