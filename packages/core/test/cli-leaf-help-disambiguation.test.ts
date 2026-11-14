import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { agentMuxCliRequestsHelp, type AgentMuxCliCommand } from '../src/agentmux-cli-commands.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const probe = new ObjectCliProbe()
const evidencePath = process.env.AGENTMUX_TEST_LEAF_HELP_EVIDENCE
const observations: Array<Record<string, unknown>> = []
beforeAll(() => probe.start())
afterAll(async () => {
  await probe.stop()
  if (evidencePath) await writeFile(evidencePath, JSON.stringify({ observations }, null, 2) + '\n')
})
async function run(args: string[], input = '') {
  const result = await probe.run(args, input, { AGENTMUX_RPC_ENDPOINT: 'unix:' + probe.socketPath })
  observations.push({ args, code: result.code, stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr).digest('hex') })
  return result
}

// The exact mandatory-carrier cases found by the independent registry audit.
// These names are test inputs; the implementation derives no grammar from them.
const mandatory = [
  'settings.executors.create', 'settings.executors.update', 'settings.executors.refresh',
  'settings.executors.unregister', 'settings.executors.register', 'settings.prompts.create',
  'settings.prompts.update', 'settings.themes.create', 'settings.themes.update', 'settings.themes.delete',
  'settings.derived-actions.create', 'settings.derived-actions.update', 'settings.applications.configure',
  'settings.applications.delete', 'settings.applications.plan', 'settings.applications.apply',
  'toolkit.create', 'toolkit.install', 'toolkit.update'
]

it('the compiled CLI exposes both direct help spellings for every audited mandatory-carrier leaf without Source or business RPC', async () => {
  const before = probe.requests.length
  expect(mandatory).toHaveLength(19)
  for (const method of mandatory) for (const flag of ['--help', '-h']) {
    const result = await run(['--source-host', 'not-read-for-help', ...method.split('.'), flag])
    expect(result.code, method + ': ' + result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: amux ' + method.replaceAll('.', ' '))
  }
  expect(probe.requests).toHaveLength(before)
}, 30000)

it('valid single-positional help IDs still cross the compiled CLI and original RPC transport as literal data', async () => {
  for (const [method, field] of [['settings.executors.inspect', 'id'], ['toolkit.inspect', 'toolId']] as const) {
    const before = probe.requests.length
    const result = await run([...method.split('.'), '--help'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    expect(probe.requests.slice(before)).toEqual([expect.objectContaining({ method, params: expect.objectContaining({ [field]: '--help' }) })])
  }
})

it('an explicit complete carrier keeps the same help-looking ID on Settings and Toolkit business routes', async () => {
  for (const [method, field] of [['settings.prompts.create', 'id'], ['toolkit.create', 'toolId']] as const) {
    const before = probe.requests.length
    const result = await run([...method.split('.'), '--help', '--input', probe.inputPath])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    expect(probe.requests.slice(before)).toEqual([expect.objectContaining({ method, params: expect.objectContaining({ [field]: '--help' }) })])
  }
})

it('extra invalid data or an incomplete carrier cannot be swallowed by help and never reaches RPC', async () => {
  const before = probe.requests.length
  for (const args of [
    ['settings', 'executors', 'inspect', '--help', '--unexpected'],
    ['settings', 'executors', 'create', '--help', '--input'],
    ['toolkit', 'install', '--help', '--unexpected']
  ]) {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
  }
  expect(probe.requests).toHaveLength(before)
})

it('the original parser is consulted only for single help ambiguity and unknown failures remain original failures', async () => {
  const failure = new AgentMuxError('Original syntax observation unavailable.', 'CONTROL_UNAVAILABLE')
  const parse = vi.fn(async () => { throw failure })
  const command: AgentMuxCliCommand = { method: 'original.inspect', usage: '<id>', summary: 'Original', positionalData: 1, parse }
  await expect(agentMuxCliRequestsHelp(command, [])).resolves.toBe(false)
  await expect(agentMuxCliRequestsHelp(command, ['literal'])).resolves.toBe(false)
  expect(parse).not.toHaveBeenCalled()
  await expect(agentMuxCliRequestsHelp(command, ['--help'])).rejects.toBe(failure)
})

it('actual module skills discover the existing Browser preparation owner without making a request', async () => {
  const before = probe.requests.length
  for (const module of ['browser', 'agent', 'space']) {
    const result = await run([module, '--skill'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('browser agent-workspace')
    expect(result.stdout).toContain('prepare')
  }
  expect(probe.requests).toHaveLength(before)
})
