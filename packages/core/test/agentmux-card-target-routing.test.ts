import { execFile } from 'node:child_process'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt } from '../src/control-host.js'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxInspectedRegion } from '../src/control.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxError } from '../src/errors.js'
import { formatMessagingAddress } from '../../../apps/desktop/src/renderer/src/lib/agent-address.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const tabId = 'tab-card'
const sid = 'agent-card'
const region = (regionId: string, agentSessionId: string | null): AgentMuxInspectedRegion => ({
  tabId, regionId, workspaceId: 'workspace-card',
  ...(agentSessionId === null ? { kind: 'launcher' as const } : {
    kind: 'agent' as const, agentSessionId, providerId: 'codex', executorId: 'codex'
  }),
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  neighbors: { left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' } }
})

// Real compiled public bin, Unix Control and durable queue; only Desktop facts/submit are a mock owner.
// No Agent CLI is launched or production App/Run operated; an isolated SDK Runtime may activate.
describe('copied card commands through the compiled public CLI', () => {
  let root: string, server: AgentMuxControlServer, env: NodeJS.ProcessEnv
  let regions: AgentMuxInspectedRegion[], seen: AgentMuxControlRequest[], submitted: string[]
  let replaced: boolean

  beforeEach(async () => {
    root = await mkdtemp('/tmp/amx-card-')
    regions = [region('region-card-a', sid), region('region-card-b', sid)]
    seen = []; submitted = []; replaced = false
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_')))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
    server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation === 'inspect.tab') return { operation: request.operation,
        tab: { tabId, workspaceId: 'workspace-card', regions } }
      if (request.operation === 'list.active-agents') {
        if (replaced) regions = [region('region-card-a', 'agent-replacement')]
        return { operation: request.operation, agents: [{
        agentSessionId: sid, workspacePath: root, providerId: 'codex', executorId: 'codex',
        projectId: null, projectName: null, processState: 'running', status: 'unknown', updatedAt: 1,
        promptCondition: { expectedRun: { runId: 'run-card' }, afterSubmissionId: null }
      }] }
      }
      if (request.operation === 'send') {
        if (replaced) throw new AgentMuxError('The Tab recipient changed after inspection.', 'MESSAGE_RECIPIENT_MISMATCH')
        expect(request.message?.recipientSessionId).toBe(sid)
        expect(request.message?.recipient).toEqual({ kind: 'agent-session', agentSessionId: sid })
        expect(request.promptCondition).toEqual({ expectedRun: { runId: 'run-card' }, afterSubmissionId: null })
        submitted.push(request.text)
        return { operation: request.operation, agentSessionId: sid }
      }
      // Reaching this owner proves the printed spatial command passed the real public parser;
      // this fixture does not pretend to have an App presentation owner.
      throw new AgentMuxError('No private App projection owner in this fixture.', 'CONTROL_OWNER_LOST')
    } }, join(root, 'control.sock'))
    await server.start()
  })

  afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true }) })

  async function run(args: string[]) {
    try { return { code: 0, ...await exec(process.execPath, [cli, ...args], { env, timeout: 5_000 }) } }
    catch (error) { return error as { code: number; stdout: string; stderr: string } }
  }

  function printedFailure(result: { code: number; stdout: string; stderr: string }) {
    expect(result.code).toBe(1); expect(result.stdout).toBe('')
    const lines = result.stderr.split('\n').filter(line => line.startsWith('{'))
    expect(lines).toHaveLength(1)
    const receipt = parseAgentMuxControlReceipt(JSON.parse(lines[0]!))
    expect(receipt.ok).toBe(false)
    if (receipt.ok) throw new Error('Expected an actual error receipt.')
    return receipt
  }

  it('sends once to the one distinct SID in two Regions and keeps the original durable condition', async () => {
    expect(regions.map(item => item.regionId)).toEqual(['region-card-a', 'region-card-b'])
    const args = ['send', '--to-tab=' + tabId, '--text', '  original task\n第二行  ', '--message-id', 'card-message']
    const result = await run(args)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'send', result: { agentSessionId: sid } })
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab', 'list.active-agents', 'send'])
    expect(submitted).toEqual(['  original task\n第二行  '])
    const queue = new DurableAgentMuxMessageQueue(env.AGENTMUX_MESSAGE_QUEUE_PATH!)
    expect((await queue.readJournal()).map(item => item.kind)).toEqual(['message', 'prompt-condition', 'delivery'])
    const messages = await queue.listAfter()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ envelope: { messageId: 'card-message', recipientSessionId: sid,
      recipient: { kind: 'agent-session', agentSessionId: sid }, body: '  original task\n第二行  ' },
      promptCondition: { expectedRun: { runId: 'run-card' }, afterSubmissionId: null }, delivery: { state: 'delivered' } })
  })

  it('reports all Region IDs per distinct SID before append or submit, with a valid public error receipt', async () => {
    regions.push(region('region-reviewer', 'agent-reviewer'))
    const receipt = printedFailure(await run(['send', '--to-tab', tabId, '--text', 'do not deliver']))
    expect(receipt.error).toEqual({ code: 'MESSAGE_TARGET_NOT_UNIQUE', message: expect.any(String), candidates: [
      { agentSessionId: sid, regionIds: ['region-card-a', 'region-card-b'] },
      { agentSessionId: 'agent-reviewer', regionIds: ['region-reviewer'] }
    ] })
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab'])
    expect(submitted).toEqual([])
    await expect(access(env.AGENTMUX_MESSAGE_QUEUE_PATH!)).rejects.toMatchObject({ code: 'ENOENT' })
    const { candidates: _omitted, ...missing } = receipt.error
    expect(() => parseAgentMuxControlReceipt({ ...receipt, error: missing })).toThrow('candidates are required')
  })

  it('returns the different zero-Agent outcome before append or submit, without a malformed error', async () => {
    regions = [region('region-empty', null)]
    expect(regions).toHaveLength(1)
    const receipt = printedFailure(await run(['send', '--to-tab', tabId, '--text', 'no recipient']))
    expect(receipt.error).toMatchObject({ code: 'MESSAGE_TARGET_NOT_UNIQUE', candidates: [] })
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab']); expect(submitted).toEqual([])
    await expect(access(env.AGENTMUX_MESSAGE_QUEUE_PATH!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains one exact intent and never reroutes or resends after the final owner rejects a replaced recipient', async () => {
    replaced = true
    const receipt = printedFailure(await run(['send', '--to-tab', tabId, '--text', 'original recipient', '--message-id', 'card-race']))
    expect(receipt.error.code, receipt.error.message).toBe('MESSAGE_RECIPIENT_MISMATCH')
    expect(seen.map(item => item.operation)).toEqual(['inspect.tab', 'list.active-agents', 'send'])
    expect(submitted).toEqual([])
    const queue = new DurableAgentMuxMessageQueue(env.AGENTMUX_MESSAGE_QUEUE_PATH!)
    expect((await queue.readJournal()).map(item => item.kind)).toEqual(['message', 'prompt-condition', 'delivery-issue'])
    expect(await queue.listAfter()).toEqual([expect.objectContaining({
      envelope: expect.objectContaining({ messageId: 'card-race', recipientSessionId: sid, body: 'original recipient' }),
      promptCondition: { expectedRun: { runId: 'run-card' }, afterSubmissionId: null }, delivery: { state: 'queued', at: expect.any(Number), reason: expect.any(String) }
    })])
  })

  it('executes the printed exact spatial commands through the actual shell and CLI without guessing a SID position', async () => {
    const card = formatMessagingAddress({ agentSessionId: "agent with 'quotes'", regionId: "region with 'quotes'" })
    const commands = card.split('\n').filter(line => line.startsWith('agentmux focus ') || line.startsWith('agentmux inspect --region='))
    expect(commands).toHaveLength(2)
    const quoted = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    for (const command of commands) {
      const script = `agentmux() { ${quoted(process.execPath)} ${quoted(cli)} "$@"; }; ${command}`
      const result = await exec('/bin/zsh', ['-f', '-c', script], { env, timeout: 5_000 })
        .then(output => ({ code: 0, ...output }), error => error as { code: number; stdout: string; stderr: string })
      expect(printedFailure(result).error.code).toBe('CONTROL_OWNER_LOST')
    }
    expect(seen.map(item => item.operation)).toEqual(['inspect.region', 'focus'])
    expect(seen[0]).toMatchObject({ target: { kind: 'region', regionId: "region with 'quotes'" } })
    expect(seen[1]).toMatchObject({ target: { kind: 'space', regionId: "region with 'quotes'" }, inputPolicy: 'preserve' })
    expect(card).toContain("--expect-session='agent with '\"'\"'quotes'\"'\"''")
    expect(card).toContain("模板：agentmux space mv ")
    expect(card).toContain("--zone='<zone-id>'")
    expect(submitted).toEqual([])
  })
})
