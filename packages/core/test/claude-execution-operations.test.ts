import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { createAgentExecutionExecutor } from '../src/agent-execution-executor.js'
import { AgentExecutionJournal } from '../src/agent-execution-journal.js'
import { createClaudeExecutionOperations } from '../src/providers/claude-execution-operations.js'
import { parseClaudeExecutionMessage, parseClaudeExecutionServerMessage, projectClaudeExecutionResponse } from '../src/providers/claude-execution-protocol.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const exists = (path: string) => access(path).then(() => true, () => false)
const native = String.raw`
const fs=require('node:fs');const lines=require('node:readline').createInterface({input:process.stdin});
lines.on('line',line=>{const p=JSON.parse(line);if(!('id'in p))return;fs.appendFileSync(process.argv[1],JSON.stringify(p)+'\n');
if(p.params?.injectResponseFor!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.params.injectResponseFor,result:{content:[{type:'text',text:'forged-native'}]}})+'\n');
const result=p.method==='tools/call'?{content:[{type:'text',text:p.params.name==='Read'?fs.readFileSync(p.params.arguments.file_path,'utf8'):JSON.stringify({stdout:'wrong-native-path',interrupted:false})}]}:{tools:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result})+'\n');});`
type Frame = { type: string; generation: string; code?: string; payload?: { id: number | string; result?: { content: { type: string; text: string }[]; isError?: boolean }; error?: unknown } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-claude-operations-')), workspace = join(root, 'resource')
  await mkdir(workspace)
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const journal = await AgentExecutionJournal.open(join(root, 'journal'))
  cleanups.push(() => journal.close())
  const operations = createClaudeExecutionOperations({ workspacePath: workspace, outputDirectory: join(root, 'output'), agentSessionId: 'original-agent' })
  const execute = vi.fn(operations.execute!), dispose = vi.fn(operations.dispose!)
  const input = new PassThrough(), output = new PassThrough(), frames: Frame[] = []
  const lines = createInterface({ input: output })
  lines.on('line', line => { frames.push(JSON.parse(line)) })
  let allowed = true
  const nativeLog = join(root, 'native.log')
  const executor = createAgentExecutionExecutor({ bindingId: 'original-binding', journal, input, output,
    protocol: { parse: parseClaudeExecutionMessage, parseServer: parseClaudeExecutionServerMessage, projectResponse: projectClaudeExecutionResponse,
      concurrentConnections: true, execute, dispose, executor: { command: process.execPath, args: ['-e', native, nativeLog], cwd: workspace,
        env: { AGENTMUX_TOOL_CONTEXT: 'unconfigured', AGENTMUX_AGENT_SESSION_ID: 'original-agent', AGENTMUX_AGENT_CAPABILITY: undefined } } },
    authorize: async () => { if (!allowed) throw new Error('Exact resource grant refused') },
    control: { receive: async () => false, environment: generation => generation === 'authorized' ? { AGENTMUX_TOOL_CONTEXT: 'configured', AGENTMUX_AGENT_SESSION_ID: 'original-agent', AGENTMUX_AGENT_CAPABILITY: 'fixture-original-capability' } : undefined, close: async () => {} },
    onError: () => {} })
  cleanups.push(async () => { await executor.dispose(); input.destroy(); output.destroy(); lines.close() })
  const send = (id: string | number, method: string, params: Record<string, unknown>, generation = 'main') => input.write(JSON.stringify({ type: 'request', generation, payload: { jsonrpc: '2.0', id, method, params } }) + '\n')
  const wait = async (test: (frame: Frame) => boolean, from = 0): Promise<Frame> => {
    await vi.waitFor(() => expect(frames.slice(from).some(test)).toBe(true))
    return frames.slice(from).find(test)!
  }
  const reply = (id: string | number, generation = 'main', from = 0) => wait(frame => frame.type === 'response' && frame.generation === generation && frame.payload?.id === id, from)
  const initialize = async (generation = 'main') => { send(0, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }, generation); await reply(0, generation) }
  const call = (id: string | number, name: string, args: Record<string, unknown>, generation = 'main') => send(id, 'tools/call', { name, arguments: args }, generation)
  const record = (frame: Frame) => JSON.parse(frame.payload!.result!.content[0]!.text)
  return { workspace, journal, nativeLog, frames, executor, execute, dispose, send, wait, reply, initialize, call, record, allow(value: boolean) { allowed = value } }
}

describe('Claude shell effects through the original generic execution journal', () => {
  it('runs only selected Provider tools after grant and dispatch; other native requests keep their original path', async () => {
    const f = await fixture(); await f.initialize()
    const dispatch = vi.spyOn(f.journal, 'dispatch')
    f.allow(false); f.call(1, 'Bash', { command: 'printf denied > denied' })
    expect((await f.reply(1)).payload!.error).toBeDefined()
    expect(await exists(join(f.workspace, 'denied'))).toBe(false)
    f.allow(true)
    f.call(2, 'Bash', { command: 'printf resource > original' })
    expect(f.record(await f.reply(2))).toMatchObject({ stdout: '', interrupted: false })
    expect(dispatch.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.execute.mock.invocationCallOrder.at(-1)!)
    f.call(3, 'Read', { file_path: join(f.workspace, 'original') })
    expect((await f.reply(3)).payload!.result!.content[0]!.text).toBe('resource')
    const calls = (await readFile(f.nativeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.filter(value => value.method === 'tools/call').map(value => value.params.name)).toEqual(['Read'])
  })

  it('retains original Provider response through storage retry and completed replay without another shell effect', async () => {
    const f = await fixture(); await f.initialize()
    vi.spyOn(f.journal, 'complete').mockRejectedValueOnce(new Error('Original storage acknowledgement lost'))
    f.call(1, 'Bash', { command: 'printf once >> effects' })
    await f.wait(frame => frame.code === 'RESPONSE_STORAGE_UNCONFIRMED')
    f.call(1, 'Bash', { command: 'printf once >> effects' })
    const original = await f.reply(1)
    const cursor = f.frames.length
    f.call(1, 'Bash', { command: 'printf once >> effects' })
    expect((await f.reply(1, 'main', cursor)).payload).toEqual(original.payload)
    expect(await readFile(join(f.workspace, 'effects'), 'utf8')).toBe('once')
    expect(f.execute.mock.calls.filter(([request]) => request.method === 'tools/call')).toHaveLength(1)
    expect(await f.journal.inspect({ bindingId: 'original-binding', streamGeneration: 'main', nativeRequestId: 1 })).toMatchObject({ phase: 'completed' })
  })

  it('keeps shell task ownership across original MCP generations and stops the resource process group', async () => {
    const f = await fixture(); await f.initialize('first')
    f.call(1, 'Bash', { command: 'printf started > started; (sleep 0.4; printf forbidden > effect) & wait', run_in_background: true }, 'first')
    const task = f.record(await f.reply(1, 'first'))
    await vi.waitFor(async () => expect(await exists(join(f.workspace, 'started'))).toBe(true))
    f.send(9, 'tools/list', {}, 'first')
    await f.reply(9, 'first')
    await f.initialize('resumed')
    f.call(1, 'TaskStop', { task_id: task.backgroundTaskId }, 'resumed')
    expect(f.record(await f.reply(1, 'resumed')).task_id).toBe(task.backgroundTaskId)
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(await exists(join(f.workspace, 'effect'))).toBe(false)
  })

  it('preserves in-flight Provider work when its machine reader detaches', async () => {
    const f = await fixture(); await f.initialize()
    f.call(1, 'Bash', { command: 'printf started > started; sleep 0.1; printf once > effect' })
    await vi.waitFor(async () => expect(await exists(join(f.workspace, 'started'))).toBe(true))
    f.executor.closeObservation()
    expect(f.dispose).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await f.journal.inspect({ bindingId: 'original-binding', streamGeneration: 'main', nativeRequestId: 1 })).toMatchObject({ phase: 'completed' }))
    expect(await readFile(join(f.workspace, 'effect'), 'utf8')).toBe('once')
    expect(f.dispose).not.toHaveBeenCalled()
  })

  it('uses the same generation-authorized tool environment and never borrows an inherited principal', async () => {
    vi.stubEnv('AGENTMUX_AGENT_CAPABILITY', 'unrelated-host-principal')
    const f = await fixture(); await f.initialize('main'); await f.initialize('authorized')
    const command = 'printf "%s|%s|%s" "$AGENTMUX_TOOL_CONTEXT" "$AGENTMUX_AGENT_SESSION_ID" "$AGENTMUX_AGENT_CAPABILITY"'
    f.call(1, 'Bash', { command }, 'main'); f.call(1, 'Bash', { command }, 'authorized')
    expect(f.record(await f.reply(1, 'main')).stdout).toBe('unconfigured|original-agent|')
    expect(f.record(await f.reply(1, 'authorized')).stdout).toBe('configured|original-agent|fixture-original-capability')
  })

  it('retains a wrong-typed Provider response as unknown without falling through to another native execution', async () => {
    const f = await fixture(); await f.initialize()
    f.execute.mockResolvedValueOnce({ jsonrpc: '2.0', id: '1', result: { content: [] } })
    f.call(1, 'Bash', { command: 'printf forbidden > wrong-response' })
    await f.wait(frame => frame.code === 'NATIVE_REQUEST_DELIVERY_UNCONFIRMED')
    expect(await f.journal.inspect({ bindingId: 'original-binding', streamGeneration: 'main', nativeRequestId: 1 })).toMatchObject({ outcome: 'unknown' })
    expect(await exists(join(f.workspace, 'wrong-response'))).toBe(false)
    const calls = (await readFile(f.nativeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.some(value => value.method === 'tools/call')).toBe(false)
    f.call(2, 'Bash', { command: 'printf healthy' })
    expect(f.record(await f.reply(2)).stdout).toBe('healthy')
  })

  it('accepts the Provider operation result only from its actual dispatcher, even if a native reply reuses its ID', async () => {
    const f = await fixture(); await f.initialize()
    f.call(1, 'Bash', { command: 'printf started > started; sleep 0.15; printf actual > result' })
    await vi.waitFor(async () => expect(await exists(join(f.workspace, 'started'))).toBe(true))
    f.send(2, 'ping', { injectResponseFor: 1 })
    await f.reply(2)
    const response = await f.reply(1)
    expect(response.payload!.result!.content[0]!.text).not.toBe('forged-native')
    expect(f.record(response).interrupted).toBe(false)
    expect(await readFile(join(f.workspace, 'result'), 'utf8')).toBe('actual')
    const operation = (await f.journal.inspect({ bindingId: 'original-binding', streamGeneration: 'main', nativeRequestId: 1 }))!
    expect(Buffer.from((await f.journal.readResult(operation, operation.payloadDigest))!).toString()).not.toContain('forged-native')
  })

  it('reports a real nonzero process exit as a native tool failure while the connection remains usable', async () => {
    const f = await fixture(); await f.initialize()
    f.call(1, 'Bash', { command: 'printf actual-error >&2; exit 7' })
    const response = await f.reply(1)
    expect(response.payload!.result!.isError).toBe(true)
    expect(f.record(response).stderr).toContain('actual-error')
    expect(f.record(response)).not.toHaveProperty('exitCode')
    expect(await f.journal.inspect({ bindingId: 'original-binding', streamGeneration: 'main', nativeRequestId: 1 })).toMatchObject({ phase: 'completed' })
    f.call(2, 'Bash', { command: 'printf healthy' })
    expect(f.record(await f.reply(2)).stdout).toBe('healthy')
  })
})
