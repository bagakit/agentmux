import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { consumeConversationWindowPage, parseConversationChangesPage, parseConversationCheckpointPage,
  parseConversationReadPage, parseConversationWatchOpening, type ConversationWatchOpening } from '../src/conversation-changes.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { transientHistoryFixture } from './helpers/transient-history-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

afterEach(() => { vi.restoreAllMocks() })

function originalIds(page: Parameters<typeof consumeConversationWindowPage>[0]) {
  const result = consumeConversationWindowPage(page)
  expect(result.kind).toBe('complete')
  if (result.kind !== 'complete') throw new Error('The original small transient window must be complete')
  expect(result.snapshot.units.length).toBeGreaterThan(0)
  return result.snapshot.units.flatMap(unit => unit.records.map(record => record.original.item.id))
}

function originalContent(page: Parameters<typeof consumeConversationWindowPage>[0]) {
  const result = consumeConversationWindowPage(page)
  if (result.kind !== 'complete') throw new Error('The same original public content must be complete')
  return result.snapshot.units.flatMap(unit => unit.records.map(record => record.original.item))
}

function expectSavedScopeGap(opening: ConversationWatchOpening, scope: ConversationWatchOpening['scope']) {
  expect(opening.scope).toEqual(scope)
  expect(opening.coverage.find(value => value.source.kind === 'native')).toMatchObject({
    source: { kind: 'native', providerId: 'claude', nativeSessionId: 'retained-old' }, current: 'unavailable',
    gaps: [expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })] })
}

async function fixture() {
  const native = await transientHistoryFixture()
  const metadata = await native.store.loadMetadata()
  const server = new AgentMuxControlServer({ socketPath: join(native.root, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: native.client }] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const ref = { hostId: 'local', agentSessionId: native.retained.agentSessionId }
  const cli = async (args: string[], stdin = ''): Promise<unknown> => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(native.root), stdin)
    expect(output.code, output.stdout + output.stderr).toBe(0)
    const envelope = JSON.parse(output.stdout)
    expect(envelope.ok).toBe(true)
    return envelope.result
  }
  const unchangedIdentity = async () => {
    expect(native.client.agentSession(ref.agentSessionId).run).toEqual(native.retained.run)
    expect(native.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(native.retained.nativeHandle)
    expect(await native.store.loadMetadata()).toEqual(metadata)
    expect(native.controls).toHaveLength(6)
    for (const index of [0, 2, 3, 4]) expect(native.controls[index]).not.toHaveBeenCalled()
  }
  return { ...native, server, rpc, ref, cli, unchangedIdentity,
    close: async () => { try { await rpc.dispose() } finally { try { await server.stop() } finally { await native.close() } } } }
}

function cliWatch(f: Awaited<ReturnType<typeof fixture>>, view?: string) {
  const executable = process.env.AGENTMUX_TEST_OBJECT_CLI ?? fileURLToPath(new URL('../bin/amux', import.meta.url))
  const child = spawn(process.execPath, [executable, '--endpoint', 'unix:' + f.server.path,
    'agent', 'conversation', 'watch', '--host', f.ref.hostId, '--session', f.ref.agentSessionId,
    ...(view ? ['--view', view] : [])], { env: objectCliEnvironment(f.root), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.once('error', error => { stderr += error.message })
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  const ended = new Promise<number | null>(resolve => child.once('close', code => { clearTimeout(timer); resolve(code) }))
  const frames = () => stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const opening = async () => {
    await vi.waitFor(() => expect(frames()[0]?.result?.initial, stderr).toBeDefined(), { timeout: 10_000 })
    return parseConversationWatchOpening(frames()[0].result.initial, f.ref)
  }
  return { frames, opening, close: async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT')
    expect(await ended, stderr).toBe(0)
  } }
}

it('original Unix RPC keeps transient inspect checkpoint changes and fixed-view watch in their exact source scopes', async () => {
  const f = await fixture()
  const subscriptions: Array<{ dispose(): Promise<void> }> = []
  try {
    const saved = await f.rpc.call('agent.conversation.inspect', f.ref)
    expect(originalIds(saved)).toEqual(['old'])
    expect(f.discover).not.toHaveBeenCalled(); expect(f.kernel.status).not.toHaveBeenCalled()
    const events = vi.fn(), currentOpening = vi.fn()
    subscriptions.push(await f.rpc.subscribe('agent.conversation.watch', f.ref, { onInitial: currentOpening, onEvent: events }))
    expect(currentOpening).toHaveBeenCalledOnce()
    expect(currentOpening.mock.calls[0]![0].scope.sources).toContainEqual({ kind: 'native', ...f.source })
    const current = await f.rpc.call('agent.conversation.inspect', f.ref)
    expect(current.scope).toEqual(currentOpening.mock.calls[0]![0].scope)
    expect(originalIds(current)).toEqual(['original'])
    const fixedOpening = vi.fn()
    subscriptions.push(await f.rpc.subscribe('agent.conversation.watch', { ...f.ref, view: saved.window.view! }, {
      onInitial: fixedOpening, onEvent() {} }))
    expectSavedScopeGap(fixedOpening.mock.calls[0]![0], saved.scope)
    f.fail('witness'); f.invalidate()
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ type: 'snapshot', data: {
      ...f.ref, sourceHostId: 'local', source: { kind: 'native', ...f.source }, kind: 'unavailable',
      code: 'AGENT_SESSION_STORE_BUSY', message: 'Private current witness is busy' } }))
    expect(f.released).not.toHaveBeenCalled()
    await f.append(); f.invalidate()
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ type: 'snapshot', data: {
      ...f.ref, sourceHostId: 'local', source: { kind: 'native', ...f.source }, kind: 'invalidated' } }))
    const changes = await f.rpc.call('agent.conversation.changes', {
      ...f.ref, view: current.window.view!, checkpoint: current.window.checkpoint })
    expect(changes.scope).toEqual(current.scope)
    expect(originalIds(changes)).toEqual(['later', 'original'])
    const checkpoint = await f.rpc.call('agent.conversation.checkpoint', f.ref)
    expect(checkpoint.scope).toEqual(current.scope)
    expect(checkpoint.checkpoint.frontier.cuts).toContainEqual(expect.objectContaining({ kind: 'native',
      checkpoint: expect.objectContaining({ source: f.source }) }))
    const replay = await f.rpc.call('agent.conversation.inspect', { ...f.ref, view: saved.window.view! })
    expect(replay.scope).toEqual(saved.scope); expect(originalIds(replay)).toEqual(['old'])
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    await expect(f.client.writeAgent({ agentSessionId: f.ref.agentSessionId, expectedRun: f.retained.run, source: 'user', data: 'x' }))
      .resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 1 } })
    expect(f.input).toHaveBeenCalledOnce(); await f.unchangedIdentity()
  } finally {
    try { for (const subscription of subscriptions.reverse()) await subscription.dispose() }
    finally { await f.close() }
  }
  expect(f.released).toHaveBeenCalledOnce()
})

it('compiled CLI current watch owns the transient witness through independent RPC windows and honest fixed-view coverage', async () => {
  const f = await fixture()
  let currentWatch: ReturnType<typeof cliWatch> | undefined, fixedWatch: ReturnType<typeof cliWatch> | undefined
  try {
    const inspectArgs = ['agent', 'conversation', 'inspect', '--host', f.ref.hostId, '--session', f.ref.agentSessionId]
    const saved = parseConversationReadPage(await f.cli(inspectArgs), f.ref)
    expect(originalIds(saved)).toEqual(['old'])
    expect(f.discover).not.toHaveBeenCalled(); expect(f.kernel.status).not.toHaveBeenCalled()
    currentWatch = cliWatch(f)
    const opening = await currentWatch.opening()
    expect(opening.scope.sources).toContainEqual({ kind: 'native', ...f.source })
    const current = parseConversationReadPage(await f.cli(inspectArgs), f.ref)
    const rpcCurrent = await f.rpc.call('agent.conversation.inspect', f.ref)
    expect(originalIds(current)).toEqual(['original']); expect(originalIds(rpcCurrent)).toEqual(['original'])
    expect(originalContent(current)).toEqual(originalContent(rpcCurrent))
    expect(current.scope).toEqual(opening.scope); expect(rpcCurrent.scope).toEqual(opening.scope)
    expect(current.window.view).not.toBe(rpcCurrent.window.view)
    expect(current.window.checkpoint.frontier).toEqual(rpcCurrent.window.checkpoint.frontier)
    fixedWatch = cliWatch(f, saved.window.view!)
    expectSavedScopeGap(await fixedWatch.opening(), saved.scope)
    await fixedWatch.close(); fixedWatch = undefined
    expect(f.released).not.toHaveBeenCalled()
    await f.append(); f.invalidate()
    await vi.waitFor(() => expect(currentWatch!.frames().flatMap(frame =>
      frame.params?.method === 'agent.conversation.watch' ? [frame.params.event] : [])).toContainEqual({ type: 'snapshot', data: {
      ...f.ref, sourceHostId: 'local', source: { kind: 'native', ...f.source }, kind: 'invalidated' } }))
    const changesInput = { ...f.ref, view: current.window.view!, checkpoint: current.window.checkpoint }
    const changes = parseConversationChangesPage(await f.cli(['agent', 'conversation', 'changes', '--input', '-'], JSON.stringify(changesInput)), changesInput)
    const rpcChanges = await f.rpc.call('agent.conversation.changes', {
      ...f.ref, view: rpcCurrent.window.view!, checkpoint: rpcCurrent.window.checkpoint })
    expect(originalIds(changes)).toEqual(['later', 'original']); expect(originalIds(rpcChanges)).toEqual(['later', 'original'])
    expect(originalContent(changes)).toEqual(originalContent(rpcChanges))
    expect(changes.scope).toEqual(opening.scope)
    expect(changes.window.checkpoint.frontier).toEqual(rpcChanges.window.checkpoint.frontier)
    const checkpoint = parseConversationCheckpointPage(await f.cli([
      'agent', 'conversation', 'checkpoint', '--host', f.ref.hostId, '--session', f.ref.agentSessionId]), f.ref)
    expect(checkpoint.scope).toEqual(opening.scope)
    // These independently produced frontier vectors retain exact per-source
    // cuts; their array positions do not establish cross-source ordering.
    const { cuts: checkpointCuts, ...checkpointScope } = checkpoint.checkpoint.frontier
    const { cuts: changesCuts, ...changesScope } = changes.window.checkpoint.frontier
    expect(checkpointScope).toEqual(changesScope)
    expect(changesCuts).toHaveLength(2); expect(checkpointCuts).toHaveLength(2)
    for (const kind of ['native', 'captured'] as const) {
      expect(changesCuts.filter(cut => cut.kind === kind)).toHaveLength(1)
      expect(checkpointCuts.filter(cut => cut.kind === kind)).toHaveLength(1)
    }
    for (const expected of changesCuts) {
      const exactSource = checkpointCuts.filter(cut => expected.kind === 'native'
        ? cut.kind === 'native' && cut.checkpoint.source.providerId === expected.checkpoint.source.providerId &&
          cut.checkpoint.source.nativeSessionId === expected.checkpoint.source.nativeSessionId
        : cut.kind === 'captured' && cut.epoch === expected.epoch)
      expect(exactSource).toHaveLength(1)
      expect(exactSource[0]).toEqual(expected)
    }
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    await currentWatch.close(); currentWatch = undefined
    await vi.waitFor(() => expect(f.released).toHaveBeenCalledOnce())
    const retained = parseConversationReadPage(await f.cli(inspectArgs), f.ref)
    expect(originalIds(retained)).toEqual(['old'])
    expect(f.discover).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
    await f.unchangedIdentity()
  } finally {
    try { await fixedWatch?.close() }
    finally { try { await currentWatch?.close() } finally { await f.close() } }
  }
})
