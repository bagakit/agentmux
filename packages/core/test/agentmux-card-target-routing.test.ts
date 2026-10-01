import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'
import { parseRpcResponse } from '../src/public-rpc-frame.js'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxInspectedRegion } from '../src/control.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxError } from '../src/errors.js'
import { formatMessagingAddress, formatRegionAddress, formatTabAddress } from '../src/sharing.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/amux', import.meta.url))
const tabId = "tab with 'quotes'"
const sid = "agent with 'quotes'"
const runId = 'run-' + sid
const region = (regionId: string, agentSessionId: string | null): AgentMuxInspectedRegion => ({
  tabId, regionId, workspaceId: 'workspace-card',
  ...(agentSessionId === null ? { kind: 'launcher' as const } : {
    kind: 'agent' as const, agentSessionId, providerId: 'codex', executorId: 'codex'
  }),
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  neighbors: { left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' } }
})

// Real compiled public bin, Unix RPC, Core Session registry and durable queue.
// Desktop facts/submit and the Native transport are fixtures; no App, Agent CLI or Run is started.
describe('copied card commands through the compiled public CLI', () => {
  let root: string, server: AgentMuxControlServer, env: NodeJS.ProcessEnv
  let owner: Awaited<ReturnType<typeof rpcOwnerFixture>>
  let regions: AgentMuxInspectedRegion[], seen: AgentMuxControlRequest[], submitted: string[]
  let replaced: boolean

  beforeEach(async () => {
    owner = await rpcOwnerFixture([sid]); root = owner.root
    regions = [region('region-card-a', sid), region('region-card-b', sid)]
    seen = []; submitted = []; replaced = false
    env = objectCliEnvironment(root)
    server = new AgentMuxControlServer({ coreClients: owner.coreClients, async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation === 'inspect.tab') return { operation: request.operation,
        tab: { tabId, workspaceId: 'workspace-card', regions } }
      if (request.operation === 'list.active-agents') {
        if (replaced) regions = [region('region-card-a', 'agent-replacement')]
        return { operation: request.operation, agents: [{
        agentSessionId: sid, workspacePath: root, providerId: 'codex', executorId: 'codex',
        projectId: null, projectName: null, processState: 'running', status: 'unknown', updatedAt: 1,
        promptCondition: { expectedRun: { runId }, afterSubmissionId: null }
      }] }
      }
      if (request.operation === 'send') {
        if (replaced) throw new AgentMuxError('The Tab recipient changed after inspection.', 'MESSAGE_RECIPIENT_MISMATCH')
        expect(request.message?.recipientSessionId).toBe(sid)
        expect(request.message?.recipient).toEqual({ kind: 'agent-session', agentSessionId: sid })
        expect(request.promptCondition).toEqual({ expectedRun: { runId }, afterSubmissionId: null })
        submitted.push(request.text)
        return { operation: request.operation, agentSessionId: sid }
      }
      // Reaching this owner proves the printed spatial command passed the real public parser;
      // this fixture does not pretend to have an App presentation owner.
      throw new AgentMuxError('No private App projection owner in this fixture.', 'CONTROL_OWNER_LOST')
    } }, join(root, 'control.sock'))
    await server.start()
  })

  afterEach(async () => { await server?.stop(); await owner?.close() })

  async function run(args: string[]) {
    try { return { code: 0, ...await exec(cli, ['--endpoint', 'unix://' + join(root, 'control.sock'), ...args], { env, timeout: 5_000 }) } }
    catch (error) { return error as { code: number; stdout: string; stderr: string } }
  }

  function printedFailure(result: { code: number; stdout: string; stderr: string }) {
    expect(result.code).toBe(1); expect(result.stdout).toBe('')
    const lines = result.stderr.split('\n').filter(line => line.startsWith('{'))
    expect(lines).toHaveLength(1)
    const receipt = JSON.parse(lines[0]!)
    expect(receipt.ok).toBe(false)
    expect(receipt.operation).toMatch(/^(agent\.send|space\.inspect)$/u)
    expect(typeof receipt.error.message).toBe('string')
    // Check the original public wire parser too; the CLI receipt is not the retired Control schema.
    const { message, ...data } = receipt.error
    parseRpcResponse({ jsonrpc: '2.0', id: 'card-error', error: { code: -32000,
      message, data } })
    return receipt
  }

  it('sends once to the one distinct SID in two Regions and keeps the original durable condition', async () => {
    expect(regions.map(item => item.regionId)).toEqual(['region-card-a', 'region-card-b'])
    const args = ['agent', 'send', '--to-tab=' + tabId, '--text', '  original task\n第二行  ', '--message-id', 'card-message']
    const result = await run(args)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'agent.send', result: { agentSessionId: sid } })
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab', 'list.active-agents', 'send'])
    expect(submitted).toEqual(['  original task\n第二行  '])
    const queue = new DurableAgentMuxMessageQueue(env.AGENTMUX_MESSAGE_QUEUE_PATH!)
    expect((await queue.readJournal()).map(item => item.kind)).toEqual(['message', 'prompt-condition', 'delivery'])
    const messages = await queue.listAfter()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ envelope: { messageId: 'card-message', recipientSessionId: sid,
      recipient: { kind: 'agent-session', agentSessionId: sid }, body: '  original task\n第二行  ' },
      promptCondition: { expectedRun: { runId }, afterSubmissionId: null }, delivery: { state: 'delivered' } })
  })

  it('reports all Region IDs per distinct SID before append or submit, with a valid public error receipt', async () => {
    regions.push(region('region-reviewer', 'agent-reviewer'))
    const receipt = printedFailure(await run(['agent', 'send', '--to-tab', tabId, '--text', 'do not deliver']))
    expect(receipt.error).toEqual({ code: 'MESSAGE_TARGET_NOT_UNIQUE', message: expect.any(String), candidates: [
      { agentSessionId: sid, regionIds: ['region-card-a', 'region-card-b'] },
      { agentSessionId: 'agent-reviewer', regionIds: ['region-reviewer'] }
    ] })
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab'])
    expect(submitted).toEqual([])
    await expect(access(env.AGENTMUX_MESSAGE_QUEUE_PATH!)).rejects.toMatchObject({ code: 'ENOENT' })
    const { candidates: _omitted, ...missing } = receipt.error
    const { message, ...data } = missing
    expect(() => parseRpcResponse({ jsonrpc: '2.0', id: 'missing-candidates', error: {
      code: -32000, message, data } })).toThrow('Ambiguous target lacks candidates')
  })

  it('returns the different zero-Agent outcome before append or submit, without a malformed error', async () => {
    regions = [region('region-empty', null)]
    expect(regions).toHaveLength(1)
    const receipt = printedFailure(await run(['agent', 'send', '--to-tab', tabId, '--text', 'no recipient']))
    expect(receipt.error).toMatchObject({ code: 'MESSAGE_TARGET_NOT_AGENT', candidates: [] })
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab']); expect(submitted).toEqual([])
    await expect(access(env.AGENTMUX_MESSAGE_QUEUE_PATH!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains one exact intent and never reroutes or resends after the final owner rejects a replaced recipient', async () => {
    replaced = true
    const receipt = printedFailure(await run(['agent', 'send', '--to-tab', tabId, '--text', 'original recipient', '--message-id', 'card-race']))
    expect(receipt.error.code, receipt.error.message).toBe('MESSAGE_RECIPIENT_MISMATCH')
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab', 'list.active-agents', 'send'])
    expect(submitted).toEqual([])
    const queue = new DurableAgentMuxMessageQueue(env.AGENTMUX_MESSAGE_QUEUE_PATH!)
    expect((await queue.readJournal()).map(item => item.kind)).toEqual(['message', 'prompt-condition', 'delivery-issue'])
    expect(await queue.listAfter()).toEqual([expect.objectContaining({
      envelope: expect.objectContaining({ messageId: 'card-race', recipientSessionId: sid, body: 'original recipient' }),
      promptCondition: { expectedRun: { runId }, afterSubmissionId: null }, delivery: { state: 'queued', at: expect.any(Number), reason: expect.any(String) }
    })])
  })

  it('executes Agent, Region and Tab ID-card commands through the actual shell with literal quoted identities', async () => {
    const regionId = "region with 'quotes'"
    const cards = [formatMessagingAddress({ agentSessionId: sid, regionId }),
      formatRegionAddress(regionId), formatTabAddress(tabId)]
    const commands = cards.map(card => card.split('\n').filter(line => line.startsWith('# amux ') && line !== '# amux --skill'))
    expect(commands.map(lines => lines.length)).toEqual([1, 1, 1])
    const quoted = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const results = []
    for (const [command] of commands) {
      const script = `amux() { ${quoted(cli)} --endpoint ${quoted('unix://' + join(root, 'control.sock'))} "$@"; }; ${command!.slice(2)}`
      const result = await exec('/bin/zsh', ['-f', '-c', script], { env, timeout: 5_000 })
        .then(output => ({ code: 0, ...output }), error => error as { code: number; stdout: string; stderr: string })
      results.push(result)
    }
    expect(results[0]!.code, results[0]!.stderr).toBe(0)
    expect(JSON.parse(results[0]!.stdout)).toMatchObject({ operation: 'agent.send', result: { agentSessionId: sid } })
    expect(printedFailure(results[1]!).error.code).toBe('CONTROL_OWNER_LOST')
    expect(printedFailure(results[2]!).error.code).toBe('CONTROL_OWNER_LOST')
    expect(seen.map(item => item.operation)).toEqual(['list.active-agents', 'send',
      'inspect.region', 'space.inspect', 'inspect.tab', 'space.inspect'])
    expect(seen[2]).toMatchObject({ target: { kind: 'region', regionId } })
    expect(seen[3]).toMatchObject({ target: { regionId } })
    expect(seen[4]).toMatchObject({ target: { kind: 'tab', tabId } })
    expect(seen[5]).toMatchObject({ target: { tabId } })
    expect(submitted).toEqual(['...'])
  })
})
