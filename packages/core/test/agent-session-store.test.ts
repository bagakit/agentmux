import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore,
  defaultAgentMuxAgentSessionStorePath,
  loadAgentSessions,
  normalizeStoredAgentSession,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem } from '../src/types.js'
import {
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory
} from '../src/runtime-paths.js'

function storedSession() {
  return {
    kind: 'agent' as const,
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 12,
    createdAt: 100,
    updatedAt: 200,
    terminalHandshake: {
      run: { runId: 'daemon-1' },
      operationId: 'terminal-handshake-1',
      inputByteRange: { startByte: 0, endByte: 5 },
      acknowledged: true
    },
    terminalPromptSubmission: {
      run: { runId: 'daemon-1' },
      submissionId: 'prompt-submit-1',
      promptDigest: 'prompt-digest-1',
      readinessEvidence: { source: 'native-stop' as const, id: 'stop-receipt-1', outputCursorBytes: 8, readyThroughByte: 12 },
      outputCursorBytes: 12,
      payload: {
        operationId: 'prompt-payload-1',
        inputByteRange: { startByte: 5, endByte: 9 },
        acknowledged: true
      },
      submit: {
        operationId: 'prompt-submit-phase-1',
        inputByteRange: { startByte: 9, endByte: 10 },
        acknowledged: true
      }
    },
    terminalPromptReadiness: {
      source: 'native-stop' as const,
      id: 'stop-receipt-1',
      run: { runId: 'daemon-1' },
      outputCursorBytes: 8,
      readyThroughByte: 12,
      consumedBySubmissionId: 'prompt-submit-1'
    },
    nativeHandle: {
      kind: 'provider' as const,
      providerId: 'codex',
      sessionId: 'native-1'
    },
    hookReceipt: {
      id: 'receipt-1',
      providerId: 'codex',
      agentSessionId: 'semantic-1',
      run: { runId: 'daemon-1' },
      eventName: 'SessionStart',
      observedAt: 200
    }
  }
}

describe('semantic session persistence boundary', () => {
  it('rejects retired File Store schemas without rewriting or migrating them', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-retired-store-')
    try {
      for (const version of [3, 4]) {
        const path = join(root, `sessions-v${version}.json`)
        const retired = `${JSON.stringify({
          version,
          sessions: [],
          reservations: [],
          retiredRuns: [],
          retiredAgentSessions: []
        })}\n`
        await writeFile(path, retired, { mode: 0o600 })
        await expect(new AgentMuxFileAgentSessionStore(path).load())
          .rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
        await expect(readFile(path, 'utf8')).resolves.toBe(retired)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds a user Stop retirement to the exact Agent Session and all of its Runs', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const current = {
      ...storedSession(),
      retiredRuns: [{ runId: 'daemon-old' }]
    }
    await store.compareAndSwap(null, current)
    const reservation = {
      reservationId: 'stop-reservation',
      ownerId: 'stop-owner',
      ownerPid: process.pid,
      kind: 'stop' as const,
      agentSessionId: current.agentSessionId,
      operationId: 'stop-operation',
      expiresAt: Date.now() + 1_000,
      expectedRun: { ...current.run },
      stopOperation: {
        daemonInstance: 'daemon-instance',
        operationKey: 'stop-operation',
        runId: current.run.runId
      }
    }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)

    await expect(store.load()).resolves.toEqual([])
    await expect(store.loadRetiredRuns()).resolves.toEqual([
      { runId: 'daemon-old' },
      { runId: 'daemon-1' }
    ])
    await expect(store.loadRetiredAgentSessions()).resolves.toEqual([
      expect.objectContaining({
        agentSessionId: 'semantic-1',
        hostId: 'local',
        run: { runId: 'daemon-1' },
        source: 'user'
      })
    ])
  })

  it('selects only semantic identity, run reference, native handle, receipt, and cursor fields', () => {
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      pid: 123,
      terminalSnapshot: 'secret terminal bytes',
      replay: ['unbounded']
    }) as unknown as Record<string, unknown>
    expect(normalized.pid).toBeUndefined()
    expect(normalized.terminalSnapshot).toBeUndefined()
    expect(normalized.replay).toBeUndefined()
    expect(normalized.terminalHandshake).toEqual(storedSession().terminalHandshake)
    expect(normalized.terminalPromptReadiness).toEqual(storedSession().terminalPromptReadiness)
    expect(normalized.terminalPromptSubmission).toEqual(storedSession().terminalPromptSubmission)
  })

  it('round-trips the terminal capability unknown/degraded fact and binds it to the current Run', () => {
    const capability = {
      state: 'unknown' as const,
      mode: 'degraded' as const,
      reason: 'handshake-timeout' as const,
      run: { runId: 'daemon-1' },
      observedAt: 200
    }
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: capability
    })
    expect(normalized.terminalCapability).toEqual(capability)
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: { ...capability, run: { runId: 'another-run' } }
    })).toThrow('Terminal capability')
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: { ...capability, state: 'verified' }
    })).toThrow('Terminal capability')
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: { ...capability, observedAt: 201 }
    })).toThrow('Terminal capability state is newer')
  })

  /**
   * 「观测事实不能比它所属的 Session 更新」这条规矩，本文件此前只对 `terminalCapability` 一条做过
   * （上面那句 `observedAt: 201`）。同一条规矩在 `normalizeStoredAgentSession` 里对三个字段各写了一遍，
   * 另外两个——`semanticStatus` 与 `terminalPromptDelivery`——一条测试都没有：把它们的 `if` 整段删掉，
   * 这个文件照旧全绿（实测）。
   *
   * 它承重是因为这三条都是 `updatedAt` 的**下游**：状态投影拿 `updatedAt` 当"这份快照有多新"的判据，
   * 而 `observedAt > updatedAt` 的记录意味着"我看到的事实比我这份快照还新"——那要么是写入路径漏了
   * 一次 `updatedAt` 递增（于是这条事实会被后续任何一次 CAS 静默覆盖掉），要么是两个进程在抢同一个
   * Session。两种都得在加载时响亮失败，而不是把一份自相矛盾的快照放进内存。
   *
   * 三个字段合在一条测试里，是因为它们守的是**同一条规矩的三个落点**：谁将来给 Session 加第四个带
   * `observedAt` 的观测字段而忘了这条界，这里的形状会告诉他该补什么。
   */
  it('三个观测字段都不许比所属 Session 更新（同一条规矩的三个落点）', () => {
    const base = storedSession()
    // 每个都先给一份"恰好同龄"的合法值（observedAt === updatedAt === 200）：边界本身是允许的，
    // 只有严格更新才该抛。这一半同时挡住把 `>` 写成 `>=` 的取反变异。
    const semanticStatus = {
      state: 'working' as const,
      source: 'native-hook' as const,
      observedAt: base.updatedAt
    }
    const promptDelivery = {
      state: 'unverified' as const,
      mode: 'degraded' as const,
      reason: 'prompt-render-timeout' as const,
      submissionId: base.terminalPromptSubmission.submissionId,
      run: { runId: base.run.runId },
      observedAt: base.updatedAt
    }
    const capability = {
      state: 'unknown' as const,
      mode: 'degraded' as const,
      reason: 'handshake-timeout' as const,
      run: { runId: base.run.runId },
      observedAt: base.updatedAt
    }
    const sameAge = normalizeStoredAgentSession({
      ...base,
      semanticStatus,
      terminalPromptDelivery: promptDelivery,
      terminalCapability: capability
    })
    expect(sameAge.semanticStatus).toEqual(semanticStatus)
    expect(sameAge.terminalPromptDelivery).toEqual(promptDelivery)
    expect(sameAge.terminalCapability).toEqual(capability)

    // 然后每次只让**一个**字段越界，另两个保持同龄——于是每一句里唯一还站着的守卫就是被测那一条。
    expect(() => normalizeStoredAgentSession({
      ...base,
      semanticStatus: { ...semanticStatus, observedAt: base.updatedAt + 1 },
      terminalPromptDelivery: promptDelivery,
      terminalCapability: capability
    })).toThrow('Semantic status is newer')
    expect(() => normalizeStoredAgentSession({
      ...base,
      semanticStatus,
      terminalPromptDelivery: { ...promptDelivery, observedAt: base.updatedAt + 1 },
      terminalCapability: capability
    })).toThrow('Terminal prompt delivery state is newer')
    expect(() => normalizeStoredAgentSession({
      ...base,
      semanticStatus,
      terminalPromptDelivery: promptDelivery,
      terminalCapability: { ...capability, observedAt: base.updatedAt + 1 }
    })).toThrow('Terminal capability state is newer')
  })

  /**
   * 一次 prompt 提交必须**原子地**消费掉它所依据的那个 readiness epoch。
   *
   * 这条规矩在 `normalizeStoredAgentSession` 里落成三道界、共 10 个析取项，而此前**一条测试都没有**：
   * 三道界的错误消息在整个 test/ 目录里零命中，任何一道整段删掉都不会有测试变红。
   *
   * 为什么承重：readiness epoch 是「终端已经把 prompt 渲染到第 N 个字节、可以安全提交了」这个事实，
   * submission 是「我依据那个事实提交了」。两者对不上，就是提交所依据的前提已经不成立——具体后果是
   * prompt 被写进一个还没准备好的终端（字节错位、命令被截断成半句），或者同一个 epoch 被两次提交
   * 各自认领（同一句话发两遍）。这些在加载时必须响亮失败，而不是把一份自相矛盾的快照放进内存、
   * 让它在某次真实提交时才炸。
   *
   * 每一句都只让**一个**析取项为真、其余全部为假，所以每一句里唯一还站着的守卫就是被测那一项。
   * 期望消息按三道界分开断言，避免一道界的失败被算作另一道的证据。
   */
  it('提交必须原子消费 readiness epoch（三道界的 10 个析取项各自承重）', () => {
    const base = storedSession()
    const submission = base.terminalPromptSubmission
    const readiness = base.terminalPromptReadiness
    // 基线：fixture 自带的一对本来就是一致的，先证它确实通过——否则下面每一句都可能是被别的
    // 原因抛出来的，而不是被我想测的那一项。
    expect(normalizeStoredAgentSession(base).terminalPromptSubmission).toEqual(submission)

    // 界一：submission 自己的 readiness 边界（三项）。这道界只看 submission 内部是否自洽，所以
    // 前两句把 readiness 整个撤掉——留着它会先被 `terminalPromptReadiness()` 自己那道「readyThrough
    // 不得早于光标」的界拦住，于是断言读到的是上游的消息，被测的这一项反而没被质询到。
    // readyThroughByte 落在 readiness 光标之前 = 「我提交所依据的准备点比准备本身还早」。
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptSubmission: { ...submission, readinessEvidence: { ...submission.readinessEvidence, readyThroughByte: 7 } },
      terminalPromptReadiness: undefined
    })).toThrow('does not preserve its readiness boundary')
    // initial-composer 这一档要求严格前进：等于光标意味着「一个字节都没渲染出来就提交」。
    // native-stop 那档允许相等（Stop 事件本身就是准备点），所以极性写反会让这条红。
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptSubmission: {
        ...submission,
        readinessEvidence: { ...submission.readinessEvidence, source: 'initial-composer' as const,
          id: 'composer-epoch-1', readyThroughByte: submission.readinessEvidence.outputCursorBytes }
      },
      terminalPromptReadiness: undefined
    })).toThrow('does not preserve its readiness boundary')
    // 输出光标退到准备点之前 = 快照声称「已读到的字节」比「已准备好的字节」还少。
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptSubmission: { ...submission, outputCursorBytes: submission.readinessEvidence.readyThroughByte - 1 }
    })).toThrow('does not preserve its readiness boundary')

    // Historical consumed observations can outlive their original completed submission.
    expect(normalizeStoredAgentSession({ ...base, terminalPromptSubmission: undefined }).terminalPromptReadiness).toEqual(readiness)
    expect(normalizeStoredAgentSession({ ...base,
      terminalPromptSubmission: { ...submission, submissionId: 'new-submission', readinessEvidence: undefined }
    }).terminalPromptSubmission?.readinessEvidence).toBeUndefined()
    expect(() => normalizeStoredAgentSession({ ...base,
      terminalPromptReadiness: { ...readiness, consumedBySubmissionId: 'another-submission' }
    })).toThrow('did not atomically consume its readiness epoch')

    // 界三：同一个 epoch 的四个取值必须在两侧逐字一致（四项）。
    // 这四句都保持 readinessId 相同（否则会掉进界二），只让一个取值发散。
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptReadiness: { ...readiness, source: 'initial-composer' as const }
    })).toThrow('did not atomically consume its readiness epoch')
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptReadiness: { ...readiness, outputCursorBytes: readiness.outputCursorBytes - 1 }
    })).toThrow('did not atomically consume its readiness epoch')
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptReadiness: { ...readiness, readyThroughByte: readiness.readyThroughByte + 1 },
      // 同步抬高 submission 侧的输出光标，免得先撞上界一的 outputCursorBytes < readyThroughByte。
      terminalPromptSubmission: { ...submission, outputCursorBytes: readiness.readyThroughByte + 1 }
    })).toThrow('did not atomically consume its readiness epoch')
    // epoch 没有认领者，却已经被一次 submission 引用——「消费」这一步丢了，于是它还能被再消费一次。
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptReadiness: { ...readiness, consumedBySubmissionId: undefined }
    })).toThrow('did not atomically consume its readiness epoch')
  })

  /**
   * client.ts 的 observeReadiness 有两处「只判 readyThroughByte === undefined，不再判
   * consumedBySubmissionId === undefined」——第二项被当作恒真删掉了。它之所以恒真，全靠这里：
   * 归一化不允许「epoch 已被某次提交认领（consumedBySubmissionId 在场）却没有 readyThroughByte」
   * 这个组合存在，于是 readyThroughByte 缺席时 consumedBySubmissionId 必然也缺席。删掉下游那两个冗余
   * 项之后，整条链的安全性就压在这一条不变量上，故它必须自己有守卫，而不是靠下游的死代码兜着。
   */
  it('归一化拦下「已被认领却没有 readyThroughByte」这个不可达组合（client.ts 两处删项的唯一靠山）', () => {
    const base = storedSession()
    const readiness = base.terminalPromptReadiness
    // 先证 fixture 自带的这一份本来就通过——否则下面的抛可能来自别的原因，而不是被我想钉的那一项。
    expect(normalizeStoredAgentSession(base).terminalPromptReadiness).toEqual(readiness)

    // consumedBySubmissionId 在场、readyThroughByte 缺席：epoch 声称「已被某次提交认领」，却拿不出
    // 「准备到了哪个字节」这条边界。这一对必须当场被 terminalPromptReadiness() 的边界界拒掉。
    expect(() => normalizeStoredAgentSession({
      ...base,
      terminalPromptReadiness: {
        source: readiness.source,
        id: readiness.id,
        run: readiness.run,
        outputCursorBytes: readiness.outputCursorBytes,
        consumedBySubmissionId: readiness.consumedBySubmissionId
        // 故意不带 readyThroughByte
      }
    })).toThrow('does not match its Agent Run boundary')
  })

  it('round-trips the launch-option posture and fails closed on a malformed selection', async () => {
    // The posture the create fixed must survive persistence so resume can re-resolve the same argv.
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      launchOptions: { sandbox: 'read-only', approval: 'never' }
    })
    expect(normalized.launchOptions).toEqual({ sandbox: 'read-only', approval: 'never' })

    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, normalized)
    const reloaded = await loadAgentSessions(store)
    // Assert the round-trip produced exactly the one session before reading it: an empty load would
    // otherwise make the posture assertion below vacuous.
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]!.launchOptions).toEqual({ sandbox: 'read-only', approval: 'never' })

    // A create that narrowed nothing stores no field and resumes on the Provider's own default.
    expect(normalizeStoredAgentSession(storedSession()).launchOptions).toBeUndefined()

    // Fail closed: empty maps and non-string choices never reach a spawn as a posture.
    expect(() => normalizeStoredAgentSession({ ...storedSession(), launchOptions: {} }))
      .toThrow('launchOptions')
    expect(() => normalizeStoredAgentSession({ ...storedSession(), launchOptions: { sandbox: 5 } }))
      .toThrow('launchOptions')
  })

  it('persists semantic status and a recoverable typed interaction response', () => {
    const value = {
      kind: 'permission' as const,
      requestId: 'receipt-1',
      decision: { outcome: 'selected' as const, optionId: 'allow-once' }
    }
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      semanticStatus: {
        state: 'waiting',
        source: 'native-hook',
        observedAt: 200,
        detail: 'PermissionRequest'
      },
      pendingInteraction: {
        request: {
          kind: 'permission',
          id: 'receipt-1',
          agentSessionId: 'semantic-1',
          title: 'Allow command?',
          options: [
            { id: 'allow-once', label: 'Allow', kind: 'allow-once' },
            { id: 'reject-once', label: 'Deny', kind: 'reject-once' }
          ],
          evidence: {
            source: 'native-hook',
            observedAt: 200,
            run: { runId: 'daemon-1' },
            hookReceiptId: 'receipt-1'
          }
        },
        response: {
          value,
          responseDigest: createHash('sha256').update(JSON.stringify(value)).digest('base64url'),
          operationId: 'interaction-operation-1',
          inputByteRange: { startByte: 10, endByte: 11 },
          acknowledged: false
        }
      }
    })
    expect(normalized.semanticStatus?.state).toBe('waiting')
    expect(normalized.pendingInteraction?.response?.value).toEqual(value)

    expect(() => normalizeStoredAgentSession({
      ...normalized,
      pendingInteraction: {
        ...normalized.pendingInteraction,
        response: {
          ...normalized.pendingInteraction!.response,
          responseDigest: 'tampered'
        }
      }
    })).toThrow('digest')

    expect(() => normalizeStoredAgentSession({
      ...normalized,
      pendingInteraction: {
        ...normalized.pendingInteraction,
        response: {
          ...normalized.pendingInteraction!.response,
          value: {
            kind: 'permission',
            requestId: 'receipt-1',
            decision: { outcome: 'invented', optionId: 'allow-once' }
          }
        }
      }
    })).toThrow('Permission response is invalid')

    expect(() => normalizeStoredAgentSession({
      ...normalized,
      pendingInteraction: {
        request: {
          ...normalized.pendingInteraction!.request,
          options: [
            { id: 'same', label: 'Allow', kind: 'allow-once' },
            { id: 'same', label: 'Deny', kind: 'reject-once' }
          ]
        }
      }
    })).toThrow('duplicate identifiers')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      pendingInteraction: {
        request: {
          kind: 'question',
          id: 'multi-question',
          agentSessionId: 'semantic-1',
          questions: [
            { id: 'first', prompt: 'First?', options: [{ id: 'a', label: 'A' }] },
            { id: 'second', prompt: 'Second?', options: [{ id: 'b', label: 'B' }] }
          ],
          evidence: {
            source: 'native-hook',
            observedAt: 200,
            run: { runId: 'daemon-1' },
            hookReceiptId: 'receipt-1'
          }
        }
      }
    })).toThrow('Question request is invalid')

    expect(normalizeStoredAgentSession({
      ...normalized,
      hookReceipt: {
        ...normalized.hookReceipt,
        id: 'later-receipt',
        eventName: 'PostToolUse'
      }
    }).pendingInteraction?.request.id).toBe('receipt-1')
  })

  it('rejects mismatched receipts and duplicate semantic identities', async () => {
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      run: { runId: 'daemon-1', generation: 'retired-identity' }
    })).toThrow('only runId')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalHandshake: {
        ...storedSession().terminalHandshake,
        run: { runId: 'another-run' }
      }
    })).toThrow('does not match')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      hookReceipt: {
        ...storedSession().hookReceipt,
        run: { runId: 'another-run' }
      }
    })).toThrow('does not match')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalPromptReadiness: {
        ...storedSession().terminalPromptReadiness,
        consumedBySubmissionId: 'another-submission'
      }
    })).toThrow('did not atomically consume')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalPromptReadiness: {
        ...storedSession().terminalPromptReadiness,
        source: 'handshake'
      }
    })).toThrow('source is invalid')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalPromptReadiness: {
        source: 'initial-composer',
        id: 'initial-readiness',
        run: { runId: 'daemon-1' },
        outputCursorBytes: 12,
        readyThroughByte: 12
      }
    })).toThrow('does not match its Agent Run boundary')

    const store: AgentMuxAgentSessionStore = {
      async load() { return [storedSession(), storedSession()] },
      async loadRetiredRuns() { return [] },
      async loadRetiredAgentSessions() { return [] },
      async compareAndSwap() {},
      async reserveLifecycle() {},
      async claimStaleLifecycles() { return [] },
      async releaseLifecycle() {},
      async retireRuns() {},
      async commitLifecycle() {},
      async loadTimeline(agentSessionId) {
        return { agentSessionId, revision: 0, items: [] }
      },
      async applyTimelineMutation(mutation) {
        return {
          agentSessionId: mutation.agentSessionId,
          revision: 0,
          changed: false,
          mutation
        }
      }
    }
    await expect(loadAgentSessions(store)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  })

  it('does not commit a Timeline mutation after an aborted lock wait', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-abort-')
    const path = join(root, 'sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      await writeFile(`${path}.lock`, `${process.pid}\n`, { mode: 0o600 })
      const controller = new AbortController()
      const pending = store.applyTimelineMutation(
        {
          type: 'append',
          agentSessionId: 'semantic-1',
          item: {
            id: 'late-item',
            agentSessionId: 'semantic-1',
            kind: 'assistant_message',
            status: 'complete',
            source: 'acp',
            createdAt: 1,
            updatedAt: 1,
            title: 'Must not commit'
          }
        },
        controller.signal
      )
      setTimeout(() => controller.abort(), 20)

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await unlink(`${path}.lock`)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1'))
        .resolves.toEqual({ agentSessionId: 'semantic-1', revision: 0, items: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not commit a Session write after an aborted lock wait', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-abort-')
    const path = join(root, 'sessions.json')
    try {
      await writeFile(`${path}.lock`, `${process.pid}\n`, { mode: 0o600 })
      const controller = new AbortController()
      const pending = new AgentMuxFileAgentSessionStore(path).compareAndSwap(
        null,
        storedSession(),
        controller.signal
      )
      setTimeout(() => controller.abort(), 20)

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('durable session identity root', () => {
  // 宿主 AgentMux.app 会注入 AGENTMUX_AGENT_SESSION_STORE 覆盖默认路径，抹掉这里断言的 runtime 回退分支。
  // 剥掉它让 defaultAgentMuxAgentSessionStorePath() 走 fallback，测完还原，不动断言本身。
  let previousStoreOverride: string | undefined
  beforeEach(() => {
    previousStoreOverride = process.env.AGENTMUX_AGENT_SESSION_STORE
    delete process.env.AGENTMUX_AGENT_SESSION_STORE
  })
  afterEach(() => {
    if (previousStoreOverride === undefined) delete process.env.AGENTMUX_AGENT_SESSION_STORE
    else process.env.AGENTMUX_AGENT_SESSION_STORE = previousStoreOverride
  })

  it('round-trips the nativeHandle from a fresh instance and derives agent-timelines from the same root', async () => {
    // Root cause of the reported bug: the nativeHandle (the `claude --resume` / `codex resume` token)
    // must survive a restart. A second instance opened at the same path must read it back intact.
    const root = await mkdtemp(join(tmpdir(), 'agentmux-durable-store-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const writer = new AgentMuxFileAgentSessionStore(path)
      await writer.compareAndSwap(null, storedSession())
      await writer.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: {
          id: 'timeline-item-1',
          agentSessionId: 'semantic-1',
          kind: 'assistant_message',
          status: 'complete',
          source: 'acp',
          createdAt: 1,
          updatedAt: 1,
          title: 'Must survive restart'
        }
      })

      // A fresh instance simulates the next AgentMux launch reading the persisted identity.
      const reopened = new AgentMuxFileAgentSessionStore(path)
      const sessions = await loadAgentSessions(reopened)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'codex',
        sessionId: 'native-1'
      })

      // agent-timelines derives from dirname(this.path) — one durable root fixes both files.
      const timelineDirectory = join(dirname(path), 'agent-timelines')
      const timelineFiles = await readdir(timelineDirectory)
      expect(timelineFiles.length).toBeGreaterThan(0)
      const reopenedTimeline = await reopened.loadTimeline('semantic-1')
      expect(reopenedTimeline.items.map((item) => item.id)).toEqual(['timeline-item-1'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the ctxmux socket and state in the machine-level runtime temp directory', () => {
    // BOUNDARY: the daemon's socket/state are ephemeral machine-level runtime; moving them would change
    // the daemon adopt path. They must stay under the temp runtime directory, not follow the session file.
    const runtimeDirectory = defaultAgentMuxRuntimeDirectory()
    const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
    expect(runtimeDirectory.startsWith(temporaryRoot)).toBe(true)
    expect(defaultCtxmuxSocketPath().startsWith(runtimeDirectory)).toBe(true)
    expect(defaultCtxmuxStateDirectory().startsWith(runtimeDirectory)).toBe(true)
    // The default (unfixed) session store path is exactly the temp location this task moves off of.
    expect(defaultAgentMuxAgentSessionStorePath().startsWith(runtimeDirectory)).toBe(true)
  })

  it('reads only its own path — no migration, no fallback to the old temp location', async () => {
    // The old temp location's data is deleted by the OS on reboot; reading or dual-writing it would be a
    // compatibility layer for an asset that no longer exists. Plant a session at the exact old temp
    // location (via the runtime-directory override) and prove a fresh durable store never surfaces it.
    const durableRoot = await mkdtemp(join(tmpdir(), 'agentmux-durable-only-'))
    const legacyRuntime = await mkdtemp(join(tmpdir(), 'agentmux-legacy-runtime-'))
    const previousOverride = process.env.AGENTMUX_RUNTIME_DIRECTORY
    process.env.AGENTMUX_RUNTIME_DIRECTORY = legacyRuntime
    try {
      const oldTempPath = defaultAgentMuxAgentSessionStorePath()
      expect(oldTempPath.startsWith(legacyRuntime)).toBe(true)
      const legacy = new AgentMuxFileAgentSessionStore(oldTempPath)
      await legacy.compareAndSwap(null, storedSession())
      await expect(legacy.load()).resolves.toHaveLength(1)

      const durable = new AgentMuxFileAgentSessionStore(join(durableRoot, 'agent-sessions.json'))
      await expect(durable.load()).resolves.toEqual([])
    } finally {
      if (previousOverride === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
      else process.env.AGENTMUX_RUNTIME_DIRECTORY = previousOverride
      await rm(durableRoot, { recursive: true, force: true })
      await rm(legacyRuntime, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// f-23q8faabh / T-003：Timeline 落盘改 JSONL 追加。热路径一条 mutation 只追加一行，
// 不整写全文件；加载容忍崩溃撕裂的尾行；越过阈值时 compaction 成单行快照且语义不变。
// ---------------------------------------------------------------------------

describe('timeline JSONL 追加与 compaction', () => {
  function timelineItem(id: string): AgentTimelineItem {
    return {
      id,
      agentSessionId: 'semantic-1',
      kind: 'assistant_message' as const,
      status: 'complete' as const,
      source: 'acp' as const,
      createdAt: 1,
      updatedAt: 1,
      title: `Item ${id}`
    }
  }

  async function timelineFile(path: string): Promise<{ content: string; lines: string[] }> {
    const directory = join(dirname(path), 'agent-timelines')
    const entries = await readdir(directory)
    const file = entries.find((entry) => entry.endsWith('.jsonl'))
    expect(file).toBeDefined()
    const content = await readFile(join(directory, file!), 'utf8')
    return { content, lines: content.split('\n').filter((line) => line !== '') }
  }

  async function timelineFilePath(path: string): Promise<string> {
    const directory = join(dirname(path), 'agent-timelines')
    const entries = await readdir(directory)
    return join(directory, entries.find((entry) => entry.endsWith('.jsonl'))!)
  }

  it('热路径追加一行而不整写：已有内容保持字节级前缀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-jsonl-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: timelineItem('item-1')
      })
      const afterFirst = await timelineFile(path)
      expect(afterFirst.lines).toHaveLength(1)

      await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: timelineItem('item-2')
      })
      const afterSecond = await timelineFile(path)
      // 全量 rewrite 基线下这里的前缀会被重排；追加路径必须保持旧内容原封不动。
      expect(afterSecond.content.startsWith(afterFirst.content)).toBe(true)
      expect(afterSecond.lines).toHaveLength(2)

      const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1')
      expect(reopened.revision).toBe(2)
      expect(reopened.items.map((item) => item.id)).toEqual(['item-1', 'item-2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('崩溃撕裂的尾行被容忍，之前的行照常加载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-torn-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      for (const id of ['item-1', 'item-2', 'item-3']) {
        await store.applyTimelineMutation({
          type: 'append',
          agentSessionId: 'semantic-1',
          item: timelineItem(id)
        })
      }
      const filePath = await timelineFilePath(path)
      const content = await readFile(filePath, 'utf8')
      await writeFile(filePath, content.slice(0, content.length - 12), { mode: 0o600 })

      const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1')
      expect(reopened.items.map((item) => item.id)).toEqual(['item-1', 'item-2'])
      expect(reopened.revision).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('坏在中间的行是数据损坏，fail-closed 而不是静默丢弃', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-corrupt-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      for (const id of ['item-1', 'item-2', 'item-3']) {
        await store.applyTimelineMutation({
          type: 'append',
          agentSessionId: 'semantic-1',
          item: timelineItem(id)
        })
      }
      const filePath = await timelineFilePath(path)
      const lines = (await readFile(filePath, 'utf8')).split('\n')
      lines[1] = lines[1]!.slice(0, 10)
      await writeFile(filePath, lines.join('\n'), { mode: 0o600 })

      await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1'))
        .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('越过行数阈值触发 compaction：文件收敛为单行快照且语义不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-compact-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: timelineItem('item-1')
      })
      // 快照 1 行 + 256 条追加 mutation：正好到 compaction 阈值边缘。
      for (let step = 1; step <= 256; step += 1) {
        await store.applyTimelineMutation({
          type: 'update',
          agentSessionId: 'semantic-1',
          itemId: 'item-1',
          updatedAt: 1 + step,
          content: `revision ${step}`
        })
      }
      const beforeCompaction = await timelineFile(path)
      expect(beforeCompaction.lines).toHaveLength(257)

      const compacting = await store.applyTimelineMutation({
        type: 'update',
        agentSessionId: 'semantic-1',
        itemId: 'item-1',
        updatedAt: 500,
        content: 'after compaction'
      })
      const afterCompaction = await timelineFile(path)
      expect(afterCompaction.lines).toHaveLength(1)

      const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1')
      expect(reopened.revision).toBe(compacting.revision)
      expect(reopened.items).toHaveLength(1)
      expect(reopened.items[0]!.content).toBe('after compaction')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('并发写同一份 store 的锁竞争', () => {
  it('只读 load 不会被活写锁挡住，争用时把孤立 Timeline 清理留到下一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-store-read-lock-'))
    const path = join(root, 'agent-sessions.json')
    const lockPath = `${path}.lock`
    const timelineDirectory = join(root, 'agent-timelines')
    const orphan = join(timelineDirectory, 'orphan.jsonl')
    try {
      const writer = new AgentMuxFileAgentSessionStore(path)
      await writer.compareAndSwap(null, storedSession())
      await mkdir(timelineDirectory, { recursive: true })
      await writeFile(orphan, '{"orphan":true}\n', { mode: 0o600 })
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 })

      const reader = new AgentMuxFileAgentSessionStore(path)
      const loaded = await Promise.race([
        reader.load().then(() => 'loaded' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 300))
      ])
      expect(loaded).toBe('loaded')
      // 活 owner 仍在，维护旁路必须让出，不能为了删孤立文件抢走它的锁。
      await expect(readFile(orphan, 'utf8')).resolves.toContain('orphan')

      await unlink(lockPath)
      await reader.load()
      await expect(readFile(orphan, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('回收进程崩溃留下的空锁，并允许新的 Session 写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-store-stale-lock-'))
    const path = join(root, 'agent-sessions.json')
    const lockPath = `${path}.lock`
    try {
      await writeFile(lockPath, '', { mode: 0o600 })
      const staleAt = new Date(Date.now() - 5_000)
      await utimes(lockPath, staleAt, staleAt)

      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())

      await expect(store.load()).resolves.toHaveLength(1)
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('回收 owner 字段截断且已过 grace window 的锁', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-store-truncated-lock-'))
    const path = join(root, 'agent-sessions.json')
    const lockPath = `${path}.lock`
    try {
      await writeFile(lockPath, 'not-a-pid', { mode: 0o600 })
      const staleAt = new Date(Date.now() - 5_000)
      await utimes(lockPath, staleAt, staleAt)

      await new AgentMuxFileAgentSessionStore(path).compareAndSwap(null, storedSession())
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // 这条守的是「多个 Owner 同时落盘不会有人被饿死」。它曾经真的会：写入改走 durable write
  // （fsync 文件 + fsync 父目录，实测约 10ms/次）之后，持锁时长和当时的定长 10ms 退避成了同一个
  // 量级，所有等待者同步醒来一起抢，形成惊群——并发 60 时约 15% 的写入耗尽重试预算抛 BUSY。
  //
  // 断言落在**可观察结果**（一个都不许失败、每条记录都在）而不是常量值上：把退避改回定长、
  // 或把 durableWriteFile 改慢，这条都会红；而单纯调整常量数值不会误红。
  it('并发落盘不会有人被饿死，也不会互相覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-store-race-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const writers = Array.from({ length: 48 }, () => new AgentMuxFileAgentSessionStore(path))
      // 每个 writer 抢一次 lifecycle reservation：走的是同一把文件锁，但各占各的槽位，互不覆盖。
      const outcomes = await Promise.allSettled(writers.map(async (writer, index) => {
        await writer.reserveLifecycle({
          reservationId: `race-reservation-${index}`,
          ownerId: `race-owner-${index}`,
          ownerPid: process.pid,
          kind: 'create',
          agentSessionId: `race-${index}`,
          operationId: `race-operation-${index}`,
          expiresAt: 4_000_000_000_000
        })
      }))

      const rejected = outcomes.flatMap((outcome) => (
        outcome.status === 'rejected' ? [outcome.reason] : []
      ))
      expect(rejected.map((error) => (error as { code?: string })?.code ?? String(error))).toEqual([])

      // 不只是「没抛错」——每个槽位都得真的落在盘上，证明锁确实轮转过而不是有人被跳过。
      const document = JSON.parse(await readFile(path, 'utf8')) as { reservations: Array<{ reservationId: string }> }
      expect(document.reservations.map((entry) => entry.reservationId).sort()).toEqual(
        writers.map((_writer, index) => `race-reservation-${index}`).sort()
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// f-23r8fq5nw / T-005：会话存储损坏要能救回来，不是整份作废。
// 参考同文件里 timeline 读取路径对崩溃撕裂尾行的容忍（见上方 timeline 用例）——把同样的韧性
// 延伸到主存储文档：这些用例都真的把落盘文件截断/注入 NUL/翻字节，再从一个全新的 Store 实例
// 读回，断言「能读的记录被救出、坏字节进了隔离文件、瞬时错误不被当成损坏而锁定降级态」。
// ---------------------------------------------------------------------------

describe('Agent Session store corruption salvage', () => {
  function salvageSession(index: number): AgentMuxStoredAgentSession {
    return {
      kind: 'agent',
      agentSessionId: `semantic-${index}`,
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: '/private/tmp/work',
      run: { runId: `run-${index}` },
      retiredRuns: [],
      hookBindingId: `hook-${index}`,
      hookToken: `token-${index}`,
      outputCursorBytes: 0,
      createdAt: 1,
      updatedAt: 1
    }
  }

  /** 用 Store 自己把 count 条真会话写盘，拿到的正是生产写路径产出的规范字节。 */
  async function seedSalvage(count: number): Promise<{ path: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-salvage-'))
    const path = join(root, 'agent-sessions.json')
    const store = new AgentMuxFileAgentSessionStore(path)
    for (let index = 0; index < count; index += 1) {
      await store.compareAndSwap(null, salvageSession(index))
    }
    return { path, root }
  }

  /**
   * 往第 index 条记录的 agentSessionId 值里塞一个 NUL 字节。NUL 是 JSON 字符串里的非法控制字符，
   * 整份 JSON.parse 因此失败——走「按缩进分帧、逐块抢救」的分支。
   * 注意别用可打印乱码（` GARBAGE`、` !` 之类）：那种字节落进字符串值里 JSON 依然合法，
   * 记录会带着脏 id 原样存活，根本触发不了抢救——那样的用例是自欺，测不到任何东西。
   */
  function injectNulByte(text: string, index: number): Buffer {
    const cut = text.indexOf(`semantic-${index}`)
    if (cut < 0) throw new Error(`seed marker semantic-${index} not found`)
    return Buffer.concat([
      Buffer.from(text.slice(0, cut), 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(text.slice(cut), 'utf8')
    ])
  }

  async function salvageQuarantineFiles(root: string): Promise<string[]> {
    return (await readdir(root)).filter((entry) => entry.includes('.corrupt-'))
  }

  interface CapturedWarning {
    message: string
    code: string | undefined
  }

  /** 捕获一段代码期间的所有 process.emitWarning，测「抢救事件必须可观察」。 */
  async function captureWarnings(run: () => Promise<void>): Promise<CapturedWarning[]> {
    const captured: CapturedWarning[] = []
    const original = process.emitWarning
    // Node 的 emitWarning 有多个重载；这里只关心 (message, {code}) 这一种用法。
    process.emitWarning = ((warning: string | Error, options?: unknown): void => {
      const code = options && typeof options === 'object' && 'code' in options
        ? String((options as { code?: unknown }).code)
        : undefined
      captured.push({ message: warning instanceof Error ? warning.message : warning, code })
    }) as typeof process.emitWarning
    try {
      await run()
    } finally {
      process.emitWarning = original
    }
    return captured
  }

  it('救出被截断文件里完好的记录，而不是整份作废', async () => {
    const { path, root } = await seedSalvage(3)
    try {
      const original = await readFile(path)
      // 从记录中间截断：尾部记录被撕裂，靠前的完整记录必须活下来。
      await writeFile(path, original.subarray(0, Math.floor(original.length * 0.6)), { mode: 0o600 })

      const salvaged = await new AgentMuxFileAgentSessionStore(path).load()
      // 抢救到的是一个非空子集——扫到了东西才有意义（本仓已知的空集假绿）。
      expect(salvaged.length).toBeGreaterThan(0)
      expect(salvaged.length).toBeLessThan(3)
      expect((salvaged[0] as AgentMuxStoredAgentSession).agentSessionId).toBe('semantic-0')

      // 坏字节进了隔离文件，且逐字节等于损坏后的整份文件内容——没有静默丢弃。
      const [quarantine] = await salvageQuarantineFiles(root)
      expect(quarantine).toBeDefined()
      const corruptOnDisk = await readFile(path)
      expect(await readFile(join(root, quarantine!))).toEqual(corruptOnDisk)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('把注入 NUL 的那一条隔离掉，两侧完好记录都救回来（部分抢救而非全有全无）', async () => {
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      const corrupt = injectNulByte(text, 1)
      // 证明这确实已经不是合法 JSON——走的是「整份解析失败、按缩进分帧抢救」的分支，
      // 而不是把脏字节混进某个字符串值里蒙混过关。
      expect(() => JSON.parse(corrupt.toString('utf8'))).toThrow()
      await writeFile(path, corrupt, { mode: 0o600 })

      const salvaged = await new AgentMuxFileAgentSessionStore(path).load()
      const ids = salvaged.map((item) => (item as AgentMuxStoredAgentSession).agentSessionId)
      // 恰好丢掉坏的那一条，另外两条原样回来。
      expect(ids).toEqual(['semantic-0', 'semantic-2'])

      const [quarantine] = await salvageQuarantineFiles(root)
      expect(quarantine).toBeDefined()
      // 隔离文件里必须真含被注入的坏字节，而不是清洗过的版本。
      const quarantined = await readFile(join(root, quarantine!))
      expect(quarantined).toEqual(corrupt)
      expect(quarantined.includes(0)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('翻字节让一条记录过不了校验（JSON 仍合法）时，隔离原始文件并救回其余记录', async () => {
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      // 翻掉中间那条记录 kind 判别字段的一个字节：JSON 依然合法，但 normalize 会拒绝它。
      const marker = '"kind": "agent"'
      const first = text.indexOf(marker)
      const second = text.indexOf(marker, first + 1)
      expect(second).toBeGreaterThan(first)
      const corrupt = `${text.slice(0, second)}"kind": "agenX"${text.slice(second + marker.length)}`
      // 证明这确实还是合法 JSON——走的是「解析成功但单条校验失败」的抢救分支。
      expect(() => JSON.parse(corrupt)).not.toThrow()
      await writeFile(path, corrupt, { mode: 0o600 })

      const salvaged = await new AgentMuxFileAgentSessionStore(path).load()
      const ids = salvaged.map((item) => (item as AgentMuxStoredAgentSession).agentSessionId)
      expect(ids).toEqual(['semantic-0', 'semantic-2'])

      const quarantine = await salvageQuarantineFiles(root)
      expect(quarantine.length).toBe(1)
      expect((await readFile(join(root, quarantine[0]!))).toString('utf8')).toBe(corrupt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loadAgentSessions 端到端也拿到被救出的子集', async () => {
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      const corrupt = injectNulByte(text, 1)
      expect(() => JSON.parse(corrupt.toString('utf8'))).toThrow()
      await writeFile(path, corrupt, { mode: 0o600 })

      const sessions = await loadAgentSessions(new AgentMuxFileAgentSessionStore(path))
      expect(sessions.map((item) => item.agentSessionId)).toEqual(['semantic-0', 'semantic-2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('瞬时读取错误（EACCES）不被当成损坏：既不隔离也不改动原文件', async () => {
    const { path, root } = await seedSalvage(3)
    try {
      const before = await readFile(path)
      await chmod(path, 0o000)
      try {
        await expect(new AgentMuxFileAgentSessionStore(path).load())
          .rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(path, 0o600)
      }
      // 权限抖动绝不能触发抢救与截断：没有隔离文件，原文件逐字节不变。
      expect(await salvageQuarantineFiles(root)).toEqual([])
      expect(await readFile(path)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('退役 schema（版本不符）仍 fail-closed，不抢救也不隔离——本任务不引入迁移层', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-salvage-version-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const retired = `${JSON.stringify({
        version: 4,
        sessions: [salvageSession(0), salvageSession(1)],
        reservations: [],
        retiredRuns: [],
        retiredAgentSessions: []
      }, null, 2)}\n`
      await writeFile(path, retired, { mode: 0o600 })

      await expect(new AgentMuxFileAgentSessionStore(path).load())
        .rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      // 版本不符不是损坏：不得隔离，也不得改写原文件。
      expect(await salvageQuarantineFiles(root)).toEqual([])
      expect(await readFile(path, 'utf8')).toBe(retired)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('隔离写盘失败也要把能读的记录救回来，绝不被一次写成功绑架', async () => {
    // MAJOR-1：磁盘故障既是 store 损坏的主因、又是隔离写失败的主因，最需要救援的场景恰恰是
    // 隔离最可能失败的场景。这里 lock 与 read 都成功，只让 quarantine 写盘失败——
    // 做法是把内容寻址出来的 sidecar 路径先占成一个目录，durableWriteFile 的 rename 撞上必失败。
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      const corrupt = injectNulByte(text, 1)
      await writeFile(path, corrupt, { mode: 0o600 })

      // 预先把 quarantine 目标路径占成目录，逼真地制造「隔离写失败但 store 可读」。
      const digest = createHash('sha256').update(corrupt).digest('base64url').slice(0, 16)
      const sidecar = `${path}.corrupt-${digest}`
      await mkdir(sidecar, { recursive: true })
      await writeFile(join(sidecar, 'blocker'), 'x')

      // 关键断言：即便隔离写不进去，能读的记录照样救回来，load() 不抛。
      const salvaged = await new AgentMuxFileAgentSessionStore(path).load()
      const ids = salvaged.map((item) => (item as AgentMuxStoredAgentSession).agentSessionId)
      expect(ids).toEqual(['semantic-0', 'semantic-2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('抢救事件对运维可见：发 warning 报明救回几条、丢了几条、隔离文件在哪', async () => {
    // MAJOR-2：抢救不能完全静默。整份 JSON 坏掉后逐块抢救，必须发一条 warning 让运维看得见。
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      const corrupt = injectNulByte(text, 1)
      await writeFile(path, corrupt, { mode: 0o600 })

      let salvagedIds: string[] = []
      const warnings = await captureWarnings(async () => {
        const salvaged = await new AgentMuxFileAgentSessionStore(path).load()
        salvagedIds = salvaged.map((item) => (item as AgentMuxStoredAgentSession).agentSessionId)
      })
      expect(salvagedIds).toEqual(['semantic-0', 'semantic-2'])

      const salvageWarning = warnings.find((w) => w.code === 'AGENT_SESSION_STORE_SALVAGED')
      expect(salvageWarning).toBeDefined()
      // warning 里要能看出救回数、丢弃数，以及隔离文件在哪。
      expect(salvageWarning!.message).toContain('salvaged 2 of 3')
      expect(salvageWarning!.message).toContain('lost 1')
      const [quarantine] = await salvageQuarantineFiles(root)
      expect(quarantine).toBeDefined()
      expect(salvageWarning!.message).toContain(quarantine!)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('隔离写失败时也发 warning，绝不静默吞掉写失败', async () => {
    // MAJOR-1 与 MAJOR-2 的交互：quarantine 改成 best-effort 之后，写失败不能变成静默——
    // 既要有「隔离失败」的 warning，也要在 salvage warning 里标明字节没能隔离。
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      const corrupt = injectNulByte(text, 1)
      await writeFile(path, corrupt, { mode: 0o600 })

      const digest = createHash('sha256').update(corrupt).digest('base64url').slice(0, 16)
      const sidecar = `${path}.corrupt-${digest}`
      await mkdir(sidecar, { recursive: true })
      await writeFile(join(sidecar, 'blocker'), 'x')

      const warnings = await captureWarnings(async () => {
        await new AgentMuxFileAgentSessionStore(path).load()
      })
      const quarantineFailure = warnings.find((w) => w.code === 'AGENT_SESSION_STORE_QUARANTINE_FAILED')
      expect(quarantineFailure).toBeDefined()
      const salvageWarning = warnings.find((w) => w.code === 'AGENT_SESSION_STORE_SALVAGED')
      expect(salvageWarning).toBeDefined()
      // salvage warning 必须点明字节没能隔离，而不是假装隔离成功。
      expect(salvageWarning!.message).toContain('FAILED')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('截断丢失量不可知时，warning 说 UNKNOWN 而不是编一个 lost 0', async () => {
    // Review 抓到的假分母：截断把尾部记录连同其后的一切整段抹掉，被抹掉的记录不在字节流里，
    // 分帧数不到——若拿分帧块数当分母，「丢了 2 条」会被报成 `lost 0`，主动告诉运维「一条没丢」。
    // 对数据丢失报 false-negative 比不报更糟，正好击穿本 feature 要解决的问题。
    const { path, root } = await seedSalvage(3)
    try {
      const original = await readFile(path)
      await writeFile(path, original.subarray(0, Math.floor(original.length * 0.6)), { mode: 0o600 })

      let salvagedCount = 0
      const warnings = await captureWarnings(async () => {
        salvagedCount = (await new AgentMuxFileAgentSessionStore(path).load()).length
      })
      // 前提锁死：确实发生了真实丢失（救回的比盘上原有的 3 条少），否则这条测试证明不了什么。
      expect(salvagedCount).toBeGreaterThan(0)
      expect(salvagedCount).toBeLessThan(3)

      const salvageWarning = warnings.find((w) => w.code === 'AGENT_SESSION_STORE_SALVAGED')
      expect(salvageWarning).toBeDefined()
      // 必须承认原始条数不可知，绝不出现任何形式的 `lost N`——那是在无中生有一个分母。
      expect(salvageWarning!.message).toContain('UNKNOWN')
      expect(salvageWarning!.message).not.toMatch(/lost \d/u)
      expect(salvageWarning!.message).toContain(`salvaged ${salvagedCount} readable record(s)`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('锚点行被污染时同样报 UNKNOWN，不把「数不到」冒充成「一条都没有」', async () => {
    // 分帧靠 `  "sessions": [` 定位起点。这行一坏，indexOf 返回 -1、分帧返回空——
    // 此时救回 0 条，但盘上原本有 3 条。若报 `salvaged 0 of 0, lost 0`，就是全丢却宣称没丢。
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      expect(text).toContain('  "sessions": [')
      // 破坏锚点行本身（塞进 JSON 非法的控制字符），记录块原样留在盘上——
      // 损坏的是「从哪开始数」，不是记录。同时锁死前提：这确实已不是合法 JSON，
      // 否则走的根本不是分帧抢救分支（本仓踩过「构造的损坏不是损坏」这种假绿）。
      const corrupt = text.replace('  "sessions": [', '  "sessions\u0000": [')
      expect(() => JSON.parse(corrupt)).toThrow()
      await writeFile(path, corrupt, { mode: 0o600 })

      let salvagedCount = -1
      const warnings = await captureWarnings(async () => {
        salvagedCount = (await new AgentMuxFileAgentSessionStore(path).load()).length
      })
      expect(salvagedCount).toBe(0)

      const salvageWarning = warnings.find((w) => w.code === 'AGENT_SESSION_STORE_SALVAGED')
      expect(salvageWarning).toBeDefined()
      expect(salvageWarning!.message).toContain('UNKNOWN')
      // 「0 of 0」是这个 bug 最恶劣的形态：全丢了，却读起来像什么都没发生。
      expect(salvageWarning!.message).not.toContain('0 of 0')
      expect(salvageWarning!.message).not.toMatch(/lost \d/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('一次 registry 加载只为同一份坏字节报一次，不刷三条重复告警', async () => {
    // registry 的一次逻辑加载串了三次 read()（sessions / retiredRuns / retiredAgentSessions），
    // 同一份坏字节被 parse 三遍。Node 不按 code 去重（实测同 code 连发三次触发三次），
    // 不去重的话运维会看到同一条 salvage 报三遍，读成「坏了三次」。
    const { path, root } = await seedSalvage(3)
    try {
      const text = (await readFile(path)).toString('utf8')
      await writeFile(path, injectNulByte(text, 1), { mode: 0o600 })

      const store = new AgentMuxFileAgentSessionStore(path)
      const warnings = await captureWarnings(async () => {
        // 复现 registry.load() 的三次读取路径。
        await store.load()
        await store.loadRetiredRuns()
        await store.loadRetiredAgentSessions()
      })
      const salvageWarnings = warnings.filter((w) => w.code === 'AGENT_SESSION_STORE_SALVAGED')
      expect(salvageWarnings).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('lifecycle ownership survives slow operations', () => {
  async function seedAndClaim(store: AgentMuxAgentSessionStore): Promise<string[]> {
    for (const [id, ownerPid, expiresAt] of [
      ['live-expired', process.pid, 500_000],
      ['live-unexpired', process.pid, 5_000_000_000_000],
      ['dead-owner', 999_999_999, 5_000_000_000_000]
    ] as const) {
      await store.reserveLifecycle({
        reservationId: id,
        ownerId: id,
        ownerPid,
        kind: 'create',
        agentSessionId: id,
        operationId: id,
        expiresAt
      })
    }
    const claimed = await store.claimStaleLifecycles({
      ownerId: 'observer',
      ownerPid: process.pid,
      now: 1_000_000,
      expiresAt: 6_000_000_000_000
    })
    return claimed.map((reservation) => reservation.reservationId).sort()
  }

  it('memory: another client only reclaims a dead owner, never a slow live one', async () => {
    expect(await seedAndClaim(new AgentMuxMemoryAgentSessionStore())).toEqual(['dead-owner'])
  })

  it('file: reconnect preserves a live owner even after lease expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-claim-live-owner-'))
    try {
      const store = new AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json'))
      expect(await seedAndClaim(store)).toEqual(['dead-owner'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
