import { afterAll, expect, it, vi, type MockInstance } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
import type { AgentProviderSessionHistoryPage, AgentMuxStoredAgentSession } from '../src/types.js'

const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-bounded-reader-'))
  for (const key of Object.keys(process.env)) {
    if (/^(AGENTMUX_|CTXMUX_)/.test(key) || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete process.env[key]
  }
  Object.assign(process.env, {
    AGENTMUX_RUNTIME_DIRECTORY: path.join(root, 'runtime'),
    AGENTMUX_MESSAGE_QUEUE_PATH: path.join(root, 'queue.ndjson'),
    AGENTMUX_AGENT_SESSION_STORE: path.join(root, 'default-sessions.json'),
    CTXMUX_STATE_DIRECTORY: path.join(root, 'ctxmux'),
    GROK_HOME: path.join(root, 'grok'), GEMINI_CLI_HOME: path.join(root, 'gemini'),
    KIMI_CODE_HOME: path.join(root, 'kimi'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CURSOR_CONFIG_DIR: path.join(root, 'cursor')
  })
  let entered!: () => void
  let release!: () => void
  return {
    root, nativePath: path.join(root, 'transcript.jsonl'),
    entered: new Promise<void>((resolve) => { entered = resolve }),
    held: new Promise<void>((resolve) => { release = resolve }),
    enter: () => entered(), release: () => release(),
    hold: true, afterAbort: false, opened: 0, closed: 0,
    reads: [] as MockInstance<FileHandle['read']>[],
    liveHandles: new Set<FileHandle>()
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => fixture.root, tmpdir: () => fixture.root
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const file = await original.open(...args)
      if (String(args[0]) !== fixture.nativePath) return file
      fixture.opened++
      fixture.liveHandles.add(file)
      const stat = file.stat.bind(file)
      const close = file.close.bind(file)
      vi.spyOn(file, 'stat').mockImplementation(async (...options) => {
        if (fixture.hold) { fixture.enter(); await fixture.held }
        return stat(...options)
      })
      fixture.reads.push(vi.spyOn(file, 'read'))
      vi.spyOn(file, 'close').mockImplementation(async () => {
        try { await close() } finally { fixture.closed++; fixture.liveHandles.delete(file) }
      })
      return file
    }
  }
})

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry } from '../dist/index.js'
import { NativeJsonlHistoryReader } from '../dist/native-jsonl-history-reader.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

afterAll(async () => {
  fixture.release()
  await Promise.all([...fixture.liveHandles].map((handle) => handle.close()))
  await rm(fixture.root, {recursive:true, force:true})
})

it('public cancellation while Reader fstat is held stops all allocation/read, drains handles and permits a fresh nonempty read', async () => {
  const data = '{"text":"one"}\n{"text":"two"}\n'
  await writeFile(fixture.nativePath, data)
  const storePath = join(fixture.root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind:'agent', agentSessionId:'private-main', providerId:'pi', executorId:'pi', hostId:'local',
    workspacePath:fixture.root, run:{runId:'controlled-existing-run'}, retiredRuns:[],
    createdAt:1, updatedAt:1, hookBindingId:'private-binding', hookToken:'private-token',
    nativeHandle:{kind:'provider', providerId:'pi', sessionId:'private-native', transcriptPath:fixture.nativePath}
  }
  await store.compareAndSwap(null, session)
  const beforeStore = await readFile(storePath)
  const provider = {
    ...new AgentProviderRegistry().get('pi'),
    async readSessionHistoryPage(context: Parameters<typeof NativeJsonlHistoryReader.open>[0]): Promise<AgentProviderSessionHistoryPage> {
      const reader = await NativeJsonlHistoryReader.open(context)
      try {
        const items: AgentProviderSessionHistoryPage['items'] = []
        while (items.length < context.limit) {
          const entry = await reader.readPrevious()
          if (!entry) break
          if (typeof entry.value.text !== 'string') throw Error('Invalid controlled fixture text')
          items.push({id:'record:'+entry.start, kind:'assistant-message', contentParts:[{kind:'text',text:entry.value.text}]})
        }
        return {source:context.source, items:items.reverse(), nextCursor:await reader.nextCursor()}
      } finally { await reader.close() }
    }
  }
  const client = new AgentMuxClient({store, providers:[provider]})
  const owner = client as unknown as {kernel:CtxmuxRunAdapter; providerReads:Map<unknown, unknown>}
  const controls = ['start', 'stop', 'input', 'resize', 'interrupt', 'attach'] as const
  const controlSpies = controls.map((name) => vi.spyOn(owner.kernel, name))
  const allocations: number[] = []
  const allocate = Buffer.alloc.bind(Buffer)
  const allocationSpy = vi.spyOn(Buffer, 'alloc').mockImplementation((size, ...args) => {
    if (fixture.afterAbort && new Error().stack?.includes('native-jsonl-history-reader')) allocations.push(size)
    return allocate(size, ...args)
  })
  let fresh: AgentMuxClient | undefined
  try {
    const pending = client.sessionHistoryPage(session.agentSessionId, {limit:2})
    const outcome = pending.then((page) => ({page, error:undefined}), (error:unknown) => ({page:undefined,error}))
    await fixture.entered
    expect(fixture.opened).toBe(1)
    expect(fixture.liveHandles.size).toBe(1)
    fixture.afterAbort = true
    client.disconnect()
    fixture.release()
    const result = await outcome
    expect(result.error).toMatchObject({code:'AGENT_SESSION_HISTORY_CANCELLED'})
    await vi.waitFor(() => expect(fixture.liveHandles.size).toBe(0))
    expect(fixture.reads).toHaveLength(1)
    expect(fixture.reads[0]).not.toHaveBeenCalled()
    expect(allocations).toEqual([]) // Literal no allocation, including Buffer.alloc(0).
    expect(fixture.closed).toBe(1)
    expect(owner.providerReads.size).toBe(0)
    expect(await readFile(storePath)).toEqual(beforeStore)
    expect(await readFile(fixture.nativePath, 'utf8')).toBe(data)
    fixture.afterAbort = false
    fixture.hold = false
    fresh = new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(storePath), providers:[provider]})
    const page = await fresh.sessionHistoryPage(session.agentSessionId, {limit:2})
    expect(page.items.map((item) => item.contentParts)).toEqual([
      [{kind:'text',text:'one'}], [{kind:'text',text:'two'}]
    ])
    expect(page.nextCursor).toBeNull()
    expect(fixture.reads).toHaveLength(2)
    expect(fixture.reads[1]).toHaveBeenCalled()
    expect(fixture.opened).toBe(2)
    expect(fixture.closed).toBe(2)
    expect(fixture.liveHandles.size).toBe(0)
    expect(await readFile(storePath)).toEqual(beforeStore)
    expect(await readFile(fixture.nativePath, 'utf8')).toBe(data)
    for (const spy of controlSpies) expect(spy).not.toHaveBeenCalled()
  } finally {
    fixture.release()
    allocationSpy.mockRestore()
    await fresh?.dispose()
    await client.dispose()
  }
})
