import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { AgentMuxControlServer, AgentMuxRpcLines, agentPromptCondition, connectLocalAgentMux } from '@agentmux/core'
import { focusFacts } from './desktop-focus-facts.ts'

/** Original packed consumer Desktop fixture; Core remains the public RPC business owner. */
export async function startPackedPublicControl({ codex, fakeCodex, coreClients, path, connectCore = connectLocalAgentMux, disposeCore = client => client.dispose() }) {
const controlRequests = []
let ambiguous = false
const agentRegion = {
  tabId: 'packed-agent-tab',
  regionId: 'packed-agent-region',
  kind: 'agent',
  agentSessionId: codex.agentSessionId,
  providerId: 'codex',
  executorId: 'codex',
  workspaceId: 'packed-workspace'
}
const packedSpaceId = JSON.stringify(['local', codex.workspacePath])
const packedZoneId = JSON.stringify([packedSpaceId, 'workspace', agentRegion.workspaceId])
const terminalRegion = {
  tabId: 'packed-agent-tab',
  regionId: 'packed-terminal-region',
  kind: 'terminal',
  runId: 'packed-terminal-run',
  workspaceId: 'packed-workspace'
}
// 只有一格、也只有一张 Tab 时的邻居：四个方向都到边。
const soleRegionNeighbors = {
  left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' }
}
const controlServer = new AgentMuxControlServer({
  ...(coreClients ? { coreClients } : {}),
  async execute(request) {
    controlRequests.push(request)
    if (request.operation === 'inspect.tab') {
      return {
        operation: request.operation,
        tab: {
          tabId: agentRegion.tabId,
          workspaceId: agentRegion.workspaceId,
          regions: ambiguous ? [
            { ...agentRegion, agentSessionId: 'packed-writer', regionId: 'packed-writer-region', bounds: { x: 0, y: 0, width: 0.5, height: 1 }, neighbors: soleRegionNeighbors },
            { ...agentRegion, agentSessionId: 'packed-reviewer', regionId: 'packed-reviewer-region', bounds: { x: 0.5, y: 0, width: 0.5, height: 1 }, neighbors: soleRegionNeighbors }
          ] : [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }]
        }
      }
    }
    if (request.operation === 'space.inspect') return { operation: request.operation, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
    if (request.operation === 'focus') {
      const result = focusFacts(request)
      result.navigation.selection.space = { ...result.navigation.selection.space,
        spaceId: packedSpaceId, zoneId: packedZoneId, workspaceId: agentRegion.workspaceId,
        groupId: 'packed-group', tabId: agentRegion.tabId }
      return result
    }
    if (request.operation === 'agent.open') {
      const existing = request.content.kind === 'agent-session'
      return {
        operation: request.operation,
        requestId: request.requestId,
        outcome: 'opened',
        from: null,
        to: { spaceId: packedSpaceId, zoneId: packedZoneId,
          workspaceId: agentRegion.workspaceId, displayWorkspaceId: agentRegion.workspaceId, groupId: 'packed-group',
          tabId: request.destination.newTab ? 'packed-agent-new-tab' : agentRegion.tabId,
          regionId: existing ? 'packed-opened-region' : 'packed-launched-region' },
        agent: { agentSessionId: existing ? request.content.agentSessionId : 'packed-launched-session',
          runId: existing ? codex.run.runId : 'packed-launched-run', providerId: 'codex', executorId: 'codex',
          hostId: 'local', cwd: codex.workspacePath, createOperationId: existing ? null : request.requestId,
          initialPrompt: existing ? 'not-requested' : 'confirmed' },
        resource: null,
        save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true,
          diskDurability: 'unconfirmed', reason: null },
        issues: []
      }
    }
    if (request.operation === 'open.terminal') {
      return {
        operation: request.operation,
        region: { ...terminalRegion, runId: 'packed-created-terminal' }
      }
    }
    if (request.operation === 'open.browser') {
      return {
        operation: request.operation,
        region: {
          tabId: agentRegion.tabId,
          regionId: 'packed-browser-region',
          workspaceId: agentRegion.workspaceId,
          kind: 'browser',
          browserId: 'packed-browser'
        }
      }
    }
    if (request.operation === 'arrange') {
      return {
        operation: request.operation,
        tab: {
          tabId: agentRegion.tabId,
          workspaceId: agentRegion.workspaceId,
          regions: [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }]
        }
      }
    }
    if (request.operation === 'list.agents') {
      return { operation: request.operation, agents: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', availability: 'available' }] }
    }
    const targetId = request.target?.kind === 'self'
      ? request.caller.agentSessionId
      : request.target?.agentSessionId
    const controlClient = await connectCore()
    try {
      if (request.operation === 'list.active-agents') {
        return { operation: request.operation, agents: await Promise.all(controlClient.agentSessions()
          .filter(session => !request.agentSessionId || session.agentSessionId === request.agentSessionId)
          .map(async session => ({ agentSessionId: session.agentSessionId, promptCondition: agentPromptCondition(session),
            projectId: null, projectName: null, workspacePath: session.workspacePath,
            providerId: session.providerId, executorId: session.executorId,
            processState: (await controlClient.statusAgent(session.agentSessionId)).run.state === 'running' ? 'running' : 'exited', status: 'unknown', updatedAt: session.updatedAt }))) }
      }
      if (request.operation === 'send') {
        await controlClient.submitAgentPrompt({
    ...request.promptCondition, agentSessionId: targetId, operationId: request.requestId, prompt: request.text })
        return { operation: request.operation, agentSessionId: targetId }
      }
      if (request.operation === 'interrupt') {
        await controlClient.signalAgent(targetId, 'SIGINT')
        return { operation: request.operation, agentSessionId: targetId }
      }
      if (request.operation === 'resume') {
        const session = await controlClient.resumeAgent({ agentSessionId: targetId, operationId: request.requestId, prompt: request.text, commandOverride: fakeCodex })
        return { operation: request.operation, agentSessionId: targetId, runId: session.run.runId }
      }
      if (request.operation === 'stop') {
        const session = controlClient.agentSession(targetId)
        await controlClient.stopAgent(targetId, session.run)
        return { operation: request.operation, agentSessionId: targetId }
      }
    } finally {
      await disposeCore(controlClient)
    }
    throw Object.assign(new Error('Unsupported packed Control request.'), { code: 'CONTROL_OPERATION_UNAVAILABLE' })
  }
}, path)
await controlServer.start()
return { controlServer, controlRequests, agentRegion, terminalRegion, packedSpaceId, packedZoneId, runId: codex.run.runId, setAmbiguous(value) { ambiguous = value } }
}

/** Shared original public assertions, consumed by the full Native fixture and a compiled RPC-only smoke. */
export async function exercisePackedPublicControl(cli, managedEnv, host) {
  const { controlRequests, agentRegion, terminalRegion, packedZoneId } = host
  const read = async (args, env = {}) => JSON.parse((await cli(args, env)).stdout)
  const cliAgents = await read(['app', 'snapshot', '--include', 'executors'])
  assert.equal(cliAgents.operation, 'app.snapshot')
  assert.deepEqual(cliAgents.result.executors, [{ executorId: 'codex', label: 'Codex', providerId: 'codex', availability: 'available' }])
  const cliContext = await read(['space', 'inspect', '--tab', 'self'], managedEnv)
  assert.equal(cliContext.operation, 'space.inspect')
  assert.equal(cliContext.result.presentation.tab.regions[0].regionId, agentRegion.regionId)
  assert.deepEqual(cliContext.result.presentation.unavailable, [])
  const launchedRegion = await read([
    'agent', 'open', '--executor', 'codex', '--prompt', '--help', '--region', agentRegion.regionId, '--split', 'right'
  ], managedEnv)
  assert.equal(launchedRegion.operation, 'agent.open')
  assert.equal(launchedRegion.result.to.regionId, 'packed-launched-region')
  assert.equal(launchedRegion.result.agent.agentSessionId, 'packed-launched-session')
  assert.equal(launchedRegion.result.agent.initialPrompt, 'confirmed')
  assert.equal(launchedRegion.result.agent.createOperationId, launchedRegion.operationId)
  assert.equal(launchedRegion.result.save.diskDurability, 'unconfirmed')
  const openedRegion = await read([
    'agent', 'open', '--session', agentRegion.agentSessionId, '--zone', packedZoneId, '--new-tab'
  ], managedEnv)
  assert.equal(openedRegion.operation, 'agent.open')
  assert.equal(openedRegion.result.to.regionId, 'packed-opened-region')
  assert.equal(openedRegion.result.to.tabId, 'packed-agent-new-tab')
  assert.equal(openedRegion.result.agent.agentSessionId, agentRegion.agentSessionId)
  assert.equal(openedRegion.result.agent.runId, host.runId)
  const openedTerminal = await read(['terminal', 'open', '--command', 'printf packed', '--below', agentRegion.regionId])
  assert.equal(openedTerminal.operation, 'terminal.open')
  assert.equal(openedTerminal.result.region.runId, 'packed-created-terminal')
  const openedBrowser = await read(['browser', 'open', '--url', 'http://localhost:5173', '--tab', agentRegion.tabId, '--new-tab'])
  assert.equal(openedBrowser.operation, 'browser.open')
  assert.equal(openedBrowser.result.region.browserId, 'packed-browser')
  const arranged = await read(['space', 'arrange', `--tab=${agentRegion.tabId}`, '--preset', 'columns-3'])
  assert.equal(arranged.operation, 'space.arrange')
  assert.equal(arranged.result.tab.tabId, agentRegion.tabId)
  // The original passive fixture has unknown DOM facts. Its structured report
  // survives the nonzero exit; this must never be presented as focus success.
  await assert.rejects(cli(['space', 'focus', '--region', terminalRegion.regionId]), error => {
    assert.equal(error.code, 1)
    const focusedRegion = JSON.parse(error.stdout)
    assert.equal(focusedRegion.operation, 'space.focus')
    assert.equal(focusedRegion.result.partial, true)
    assert.equal(focusedRegion.result.input.outcome, 'unconfirmed')
    assert.equal(focusedRegion.result.navigation.selection.space.regionId, terminalRegion.regionId)
    return true
  })
  assert.deepEqual(controlRequests.map(request => request.operation), [
    'list.agents', 'inspect.tab', 'space.inspect', 'agent.open', 'agent.open', 'open.terminal', 'open.browser', 'arrange', 'focus'
  ])
  assert.equal(controlRequests[3].content.executorId, 'codex')
  assert.equal(controlRequests[3].content.prompt, '--help')
  assert.deepEqual(controlRequests[3].destination, { regionId: agentRegion.regionId, split: 'right' })
  assert.equal(controlRequests[3].focus, false)
  assert.deepEqual(controlRequests[4].destination, { zoneId: packedZoneId, newTab: true })
  assert.equal(controlRequests[4].focus, false)
  assert.deepEqual(controlRequests[5].destination, { kind: 'split', region: { kind: 'region', regionId: agentRegion.regionId }, direction: 'down' })
  host.setAmbiguous(true)
  try {
    await assert.rejects(cli(['agent', 'send', `--to-tab=${agentRegion.tabId}`, '--text', 'review']), error => {
      const receiptLines = error.stderr.split('\n').filter(line => line.startsWith('{'))
      assert.equal(receiptLines.length, 1, 'one structured error receipt alongside native warnings')
      const receipt = JSON.parse(receiptLines[0])
      assert.equal(receipt.ok, false)
      assert.equal(typeof receipt.operationId, 'string')
      assert.equal(receipt.operation, 'agent.send', JSON.stringify(receipt))
      assert.equal(receipt.error.code, 'MESSAGE_TARGET_NOT_UNIQUE')
      assert.deepEqual(receipt.error.candidates, [
        { agentSessionId: 'packed-writer', regionIds: ['packed-writer-region'] },
        { agentSessionId: 'packed-reviewer', regionIds: ['packed-reviewer-region'] }
      ])
      return true
    })
  } finally { host.setAmbiguous(false) }
  return { openedRegion }
}

/** Fragmentation is parsed by the public framing owner, never a fixture decoder. */
export async function rawControlReceipt(path, message, splitAt) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const lines = new AgentMuxRpcLines()
    socket.once('connect', () => {
      const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
      socket.write(bytes.subarray(0, splitAt))
      setTimeout(() => socket.write(bytes.subarray(splitAt)), 10)
    })
    socket.on('data', chunk => {
      try {
        lines.accept(chunk, frame => { socket.destroy(); resolve(frame) })
      } catch (error) { socket.destroy(); reject(error) }
    })
    socket.once('end', () => {
      try { lines.end(); reject(new Error('RPC peer closed without a complete response.')) } catch (error) { reject(error) }
    })
    socket.once('error', reject)
  })
}
