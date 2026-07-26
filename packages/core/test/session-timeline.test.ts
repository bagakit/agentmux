import { chmodSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore
} from '../src/agent-session-store.js'
import {
  agentTimelineMutationFromAcpEvent,
  applyAgentTimelineMutation,
  normalizeAgentTimeline,
  normalizeAgentTimelineMutation
} from '../src/session-timeline.js'
import type {
  AgentMuxStoredAgentSession,
  AgentTimelineMutation
} from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

function session(agentSessionId: string, runId: string): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId,
    providerId: 'codex',
    executorId: 'codex-safe',
    hostId: 'local',
    workspacePath: '/private/tmp/agentmux-timeline',
    run: { runId },
    retiredRuns: [],
    hookBindingId: `hook-${agentSessionId}`,
    hookToken: `token-${agentSessionId}`,
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function assistantAppend(
  agentSessionId = 'session-1'
): Extract<AgentTimelineMutation, { type: 'append' }> {
  return {
    type: 'append',
    agentSessionId,
    item: {
      id: 'assistant-1',
      agentSessionId,
      kind: 'assistant_message',
      status: 'streaming',
      source: 'acp',
      createdAt: 10,
      updatedAt: 10,
      title: 'Assistant response',
      content: 'Hello'
    }
  }
}

describe('Agent Session Timeline', () => {
  it('replays cumulative full-content updates without duplicating streamed text', () => {
    const appended = applyAgentTimelineMutation([], assistantAppend())
    expect(applyAgentTimelineMutation(appended, assistantAppend())).toEqual(appended)

    const update: AgentTimelineMutation = {
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 11,
      content: 'Hello, world',
      status: 'complete'
    }
    const updated = applyAgentTimelineMutation(appended, update)

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      id: 'assistant-1',
      content: 'Hello, world',
      status: 'complete',
      updatedAt: 11
    })
    expect(applyAgentTimelineMutation(updated, { ...update, updatedAt: 12 })).toEqual(updated)
    expect('contentDelta' in update).toBe(false)
    expect(() => normalizeAgentTimelineMutation({
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 12,
      contentDelta: '!'
    })).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
  })

  it('fails closed for conflicting identities, unknown update targets, and crossed Sessions', () => {
    const current = applyAgentTimelineMutation([], assistantAppend())
    expect(() => applyAgentTimelineMutation(current, {
      ...assistantAppend(),
      item: { ...assistantAppend().item, title: 'Conflicting response' }
    } as AgentTimelineMutation)).toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_ID_CONFLICT' }))
    expect(() => applyAgentTimelineMutation(current, {
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'missing',
      updatedAt: 11,
      content: 'x'
    })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_AGENT_TIMELINE_ITEM' }))
    expect(() => applyAgentTimelineMutation(current, assistantAppend('session-2')))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
  })

  describe('upsert：目标缺失时补落而非抛错', () => {
    // 一条完整的 tool_call item，模拟 normalizer 的 Post upsert 会携带的形状。
    const toolItem = (
      id: string,
      overrides: Partial<Extract<AgentTimelineMutation, { type: 'append' }>['item']> = {}
    ): Extract<AgentTimelineMutation, { type: 'upsert' }> => ({
      type: 'upsert',
      agentSessionId: 'session-1',
      item: {
        id,
        agentSessionId: 'session-1',
        kind: 'tool_call',
        status: 'complete',
        source: 'native-hook',
        createdAt: 20,
        updatedAt: 20,
        title: 'Bash',
        toolName: 'Bash',
        toolInput: 'ls',
        toolOutput: 'total 24',
        ...overrides
      }
    })

    it('目标不存在时补落一条自洽的终态行，绝不抛 UNKNOWN_AGENT_TIMELINE_ITEM', () => {
      // 这是 major 修复的核心：丢了 Pre（两次 fetch 全失败）或被 200 上限逐出后，Post 的目标压根不在。
      // 若这里抛错，client 的 timeline 循环会把它冒泡出去、跳过 publishHook、整条 hook 事件回 503。
      // 变异守卫：把实现里 upsert 的 index<0 分支改成沿用 update 的 `throw UNKNOWN_AGENT_TIMELINE_ITEM`，
      // 这条 not.toThrow 立即变红。
      expect(() => applyAgentTimelineMutation([], toolItem('run-x:tool:toolu_1'))).not.toThrow()
      const items = applyAgentTimelineMutation([], toolItem('run-x:tool:toolu_1'))
      expect(items).toHaveLength(1)
      // 补落的是完整 item（kind/source/title 俱全），不是靠残缺字段合成的空壳。
      expect(items[0]).toMatchObject({
        id: 'run-x:tool:toolu_1',
        kind: 'tool_call',
        source: 'native-hook',
        status: 'complete',
        toolOutput: 'total 24'
      })
    })

    it('目标存在时就地替换，并保留最初的 createdAt', () => {
      // Pre 落在途态（streaming, createdAt=10），Post upsert 翻成终态。一条，不是两条。
      const afterPre = applyAgentTimelineMutation([], {
        type: 'append',
        agentSessionId: 'session-1',
        item: {
          id: 'run-x:tool:toolu_2',
          agentSessionId: 'session-1',
          kind: 'tool_call',
          status: 'streaming',
          source: 'native-hook',
          createdAt: 10,
          updatedAt: 10,
          title: 'Bash',
          toolName: 'Bash',
          toolInput: 'ls'
        }
      })
      const afterPost = applyAgentTimelineMutation(afterPre, toolItem('run-x:tool:toolu_2', { updatedAt: 20 }))
      expect(afterPost).toHaveLength(1)
      expect(afterPost[0]).toMatchObject({ status: 'complete', toolOutput: 'total 24', updatedAt: 20 })
      // createdAt 仍是 Pre 的 10——这仍是「同一件事」，事后投递不该改写它的创建时刻。
      // 变异守卫：把实现里 `createdAt: previous.createdAt` 删掉（让 item 自带的 20 生效），这条变红。
      expect(afterPost[0]!.createdAt).toBe(10)
    })

    it('upsert 语义未变时不推空 revision（幂等重投）', () => {
      const once = applyAgentTimelineMutation([], toolItem('run-x:tool:toolu_3'))
      // 同一条再来一次（网络重投）——内容一致就原样返回，不产生新版本。
      expect(applyAgentTimelineMutation(once, toolItem('run-x:tool:toolu_3'))).toEqual(once)
    })

    it('upsert 也受 200 上限约束——补落一条时最旧的被逐出', () => {
      let items = normalizeAgentTimeline('session-1', [])
      for (let index = 0; index < 200; index += 1) {
        items = applyAgentTimelineMutation(items, toolItem(`run-x:tool:fill_${index}`, { createdAt: index + 1, updatedAt: index + 1 }))
      }
      expect(items).toHaveLength(200)
      const grown = applyAgentTimelineMutation(items, toolItem('run-x:tool:fresh', { createdAt: 999, updatedAt: 999 }))
      expect(grown).toHaveLength(200)
      expect(grown.some((item) => item.id === 'run-x:tool:fill_0')).toBe(false)
      expect(grown.some((item) => item.id === 'run-x:tool:fresh')).toBe(true)
    })
  })

  it('maps ACP updates to full content and scopes raw ids by adapter and native Session', () => {
    const evidence = {
      source: 'acp' as const,
      observedAt: 20,
      acpAdapterId: 'adapter-1',
      acpSessionId: 'native-1'
    }
    const append = agentTimelineMutationFromAcpEvent('session-1', {
      type: 'activity',
      operation: 'append',
      activityId: 'response-1',
      kind: 'assistant_message',
      status: 'streaming',
      title: 'Assistant response',
      content: 'A'
    }, evidence)
    const update = agentTimelineMutationFromAcpEvent('session-1', {
      type: 'activity',
      operation: 'update',
      activityId: 'response-1',
      status: 'complete',
      content: 'AB'
    }, { ...evidence, observedAt: 21 })
    const permission = agentTimelineMutationFromAcpEvent('session-1', {
      type: 'permission',
      requestId: 'response-1',
      title: 'Run tests',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }]
    }, { ...evidence, observedAt: 22 })
    const otherAdapter = agentTimelineMutationFromAcpEvent('session-1', {
      type: 'activity',
      operation: 'append',
      activityId: 'response-1',
      kind: 'assistant_message',
      status: 'complete',
      title: 'Another adapter',
      content: 'Separate'
    }, { ...evidence, acpAdapterId: 'adapter-2', observedAt: 22 })
    const otherNativeSession = agentTimelineMutationFromAcpEvent('session-1', {
      type: 'activity',
      operation: 'append',
      activityId: 'response-1',
      kind: 'assistant_message',
      status: 'complete',
      title: 'Another native Session',
      content: 'Separate again'
    }, { ...evidence, acpSessionId: 'native-2', observedAt: 23 })

    expect(append).toMatchObject({ type: 'append', item: { status: 'streaming' } })
    expect(update).toMatchObject({ type: 'update', content: 'AB' })
    expect(permission).toMatchObject({ type: 'append', item: { kind: 'permission' } })
    expect(append && update && append.type === 'append' && update.type === 'update'
      ? update.itemId
      : null).toBe(append && append.type === 'append' ? append.item.id : null)
    expect(update && 'contentDelta' in update).toBe(false)
    expect(otherAdapter && otherAdapter.type === 'append' ? otherAdapter.item.id : null)
      .not.toBe(append && append.type === 'append' ? append.item.id : null)
    expect(otherNativeSession && otherNativeSession.type === 'append' ? otherNativeSession.item.id : null)
      .not.toBe(append && append.type === 'append' ? append.item.id : null)

    const combined = [append, update, permission, otherAdapter, otherNativeSession]
      .filter((mutation): mutation is AgentTimelineMutation => mutation !== null)
      .reduce<ReturnType<typeof applyAgentTimelineMutation>>(
        (items, mutation) => applyAgentTimelineMutation(items, mutation),
        []
      )
    expect(combined).toHaveLength(4)
    expect(combined.find((item) => item.content === 'AB')).toMatchObject({ status: 'complete' })
  })

  it('assigns continuous Store revisions and does not advance revision for a no-op', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, session('session-1', 'run-1'))

    await expect(store.loadTimeline('session-1')).resolves.toEqual({
      agentSessionId: 'session-1',
      revision: 0,
      items: []
    })
    await expect(store.applyTimelineMutation(assistantAppend())).resolves.toMatchObject({
      agentSessionId: 'session-1',
      revision: 1,
      changed: true,
      mutation: assistantAppend()
    })
    await expect(store.applyTimelineMutation(assistantAppend())).resolves.toMatchObject({
      agentSessionId: 'session-1',
      revision: 1,
      changed: false
    })
    await expect(store.applyTimelineMutation({
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 11,
      content: 'Hello, world',
      status: 'complete'
    })).resolves.toMatchObject({
      agentSessionId: 'session-1',
      revision: 2,
      changed: true,
      mutation: expect.objectContaining({ content: 'Hello, world' })
    })
    await expect(store.applyTimelineMutation({
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 12,
      content: 'Hello, world',
      status: 'complete'
    })).resolves.toMatchObject({
      agentSessionId: 'session-1',
      revision: 2,
      changed: false
    })
    await expect(store.loadTimeline('session-1')).resolves.toMatchObject({
      agentSessionId: 'session-1',
      revision: 2,
      items: [{ id: 'assistant-1', content: 'Hello, world', status: 'complete' }]
    })
  })

  it('rejects an empty title before changing the persisted Timeline', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, session('session-1', 'run-1'))
    await store.applyTimelineMutation(assistantAppend())

    await expect(store.applyTimelineMutation({
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 11,
      title: ''
    })).rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE' })
    await expect(store.loadTimeline('session-1')).resolves.toMatchObject({
      revision: 1,
      items: [{ title: 'Assistant response' }]
    })
  })

  it('persists each Session independently and restores the bounded Timeline after restart', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-store-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const first = new AgentMuxFileAgentSessionStore(path)
    const firstSession = session('session-1', 'run-1')
    const secondSession = session('session-2', 'run-2')
    await first.compareAndSwap(null, firstSession)
    await first.compareAndSwap(null, secondSession)
    await first.applyTimelineMutation(assistantAppend('session-1'))
    await expect(first.applyTimelineMutation(assistantAppend('session-1'))).resolves.toMatchObject({
      revision: 1,
      changed: false
    })
    await first.applyTimelineMutation({
      ...assistantAppend('session-2'),
      item: { ...assistantAppend('session-2').item, id: 'assistant-2', content: 'Separate' }
    })

    const restarted = new AgentMuxFileAgentSessionStore(path)
    await expect(restarted.loadTimeline('session-1')).resolves.toMatchObject({
      agentSessionId: 'session-1',
      revision: 1,
      items: [{ id: 'assistant-1', agentSessionId: 'session-1', content: 'Hello' }]
    })
    await expect(restarted.loadTimeline('session-2')).resolves.toMatchObject({
      agentSessionId: 'session-2',
      revision: 1,
      items: [{ id: 'assistant-2', agentSessionId: 'session-2', content: 'Separate' }]
    })

    await restarted.compareAndSwap(firstSession, null)
    await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('session-1')).resolves.toEqual({
      agentSessionId: 'session-1',
      revision: 0,
      items: []
    })

    await restarted.compareAndSwap(null, session('session-1', 'run-3'))
    await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('session-1')).resolves.toEqual({
      agentSessionId: 'session-1',
      revision: 0,
      items: []
    })
  })

  it('keeps one Agent Session Timeline across a committed Run replacement', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-resume-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const store = new AgentMuxFileAgentSessionStore(path)
    const initial = session('session-1', 'run-1')
    await store.compareAndSwap(null, initial)
    await store.applyTimelineMutation(assistantAppend())
    const reservation = {
      reservationId: 'resume-reservation',
      ownerId: 'resume-owner',
      ownerPid: process.pid,
      kind: 'resume' as const,
      agentSessionId: initial.agentSessionId,
      operationId: 'resume-operation',
      expiresAt: Date.now() + 60_000,
      expectedRun: { ...initial.run }
    }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, {
      ...initial,
      run: { runId: 'run-2' },
      retiredRuns: [{ ...initial.run }],
      hookBindingId: 'hook-session-1-run-2',
      hookToken: 'token-session-1-run-2',
      updatedAt: 2
    })
    await expect(store.loadTimeline(initial.agentSessionId)).resolves.toMatchObject({
      agentSessionId: initial.agentSessionId,
      revision: 1,
      items: [{ id: 'assistant-1', content: 'Hello' }]
    })

    await expect(store.applyTimelineMutation({
      ...assistantAppend(),
      item: {
        ...assistantAppend().item,
        id: 'run-2:receipt-1:0',
        title: 'Response after resume',
        content: 'Continued'
      }
    })).resolves.toMatchObject({ revision: 2, changed: true })
    await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline(initial.agentSessionId))
      .resolves.toMatchObject({
        revision: 2,
        items: [
          { id: 'assistant-1', content: 'Hello' },
          { id: 'run-2:receipt-1:0', content: 'Continued' }
        ]
      })
  })

  it('keeps Session commits authoritative when Timeline cleanup fails and recovers the orphan', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-cleanup-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const timelineDirectory = join(root, 'agent-timelines')
    const current = session('session-1', 'run-1')
    const store = new AgentMuxFileAgentSessionStore(path)
    await store.compareAndSwap(null, current)
    await store.applyTimelineMutation(assistantAppend())

    await chmod(timelineDirectory, 0o500)
    try {
      await expect(store.compareAndSwap(current, null)).resolves.toBeUndefined()
      await expect(store.compareAndSwap(null, session('session-1', 'run-2')))
        .rejects.toMatchObject({ code: 'EACCES' })
      const document = JSON.parse(await readFile(path, 'utf8')) as { sessions: unknown[] }
      expect(document.sessions).toEqual([])
    } finally {
      await chmod(timelineDirectory, 0o700)
    }

    const restarted = new AgentMuxFileAgentSessionStore(path)
    await expect(restarted.load()).resolves.toEqual([])
    await expect(restarted.loadTimeline('session-1')).resolves.toEqual({
      agentSessionId: 'session-1',
      revision: 0,
      items: []
    })
  })

  it('does not hide a malformed Timeline that belongs to a live Session', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-invalid-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const timelineDirectory = join(root, 'agent-timelines')
    const store = new AgentMuxFileAgentSessionStore(path)
    await store.compareAndSwap(null, session('session-1', 'run-1'))
    await store.applyTimelineMutation(assistantAppend())
    const [timelineFilename] = await readdir(timelineDirectory)
    expect(timelineFilename).toBeDefined()
    await writeFile(join(timelineDirectory, timelineFilename!), '{}\n')

    const restarted = new AgentMuxFileAgentSessionStore(path)
    await expect(restarted.load()).resolves.toHaveLength(1)
    await expect(restarted.loadTimeline('session-1'))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
  })

  it('fails closed instead of publishing a revision that is not safely monotonic', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-revision-limit-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const timelineDirectory = join(root, 'agent-timelines')
    const store = new AgentMuxFileAgentSessionStore(path)
    await store.compareAndSwap(null, session('session-1', 'run-1'))
    await store.applyTimelineMutation(assistantAppend())
    const [timelineFilename] = await readdir(timelineDirectory)
    expect(timelineFilename).toBeDefined()
    const timelinePath = join(timelineDirectory, timelineFilename!)
    const timeline = JSON.parse(await readFile(timelinePath, 'utf8')) as {
      revision: number
      items: unknown[]
    }
    await writeFile(timelinePath, `${JSON.stringify({
      version: 3,
      agentSessionId: 'session-1',
      revision: Number.MAX_SAFE_INTEGER,
      items: timeline.items
    })}\n`)

    const restarted = new AgentMuxFileAgentSessionStore(path)
    await expect(restarted.applyTimelineMutation(assistantAppend())).resolves.toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      changed: false
    })
    await expect(restarted.applyTimelineMutation({
      type: 'update',
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 11,
      content: 'This change requires the next revision.'
    })).rejects.toMatchObject({ code: 'AGENT_TIMELINE_REVISION_LIMIT' })
    await expect(restarted.loadTimeline('session-1')).resolves.toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      items: [{ id: 'assistant-1', content: 'Hello' }]
    })
  })

  it('returns a committed receipt and poisons later writes when lock cleanup fails', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-lock-release-')
    roots.push(root)
    const path = join(root, 'agent-sessions.json')
    const store = new AgentMuxFileAgentSessionStore(path)
    await store.compareAndSwap(null, session('session-1', 'run-1'))
    await mkdir(join(root, 'agent-timelines'), { mode: 0o700 })
    const mutation = assistantAppend()
    Object.defineProperty(mutation, 'agentSessionId', {
      enumerable: true,
      get() {
        chmodSync(root, 0o500)
        return 'session-1'
      }
    })
    const warning = new Promise<Error>((resolve) => {
      process.once('warning', resolve)
    })

    try {
      await expect(store.applyTimelineMutation(mutation)).resolves.toMatchObject({
        agentSessionId: 'session-1',
        revision: 1,
        changed: true
      })
    } finally {
      await chmod(root, 0o700)
    }
    await expect(warning).resolves.toMatchObject({
      name: 'Warning',
      code: 'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED'
    })
    await expect(store.applyTimelineMutation(assistantAppend()))
      .rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED' })
    await unlink(`${path}.lock`)
    await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('session-1'))
      .resolves.toMatchObject({ revision: 1, items: [{ id: 'assistant-1' }] })
  })
})
