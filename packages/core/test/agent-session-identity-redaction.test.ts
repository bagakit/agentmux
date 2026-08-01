import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cloneSession } from '../src/agent-session-identity.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

/**
 * `cloneSession` is the ONLY thing standing between the stored Agent Session and the renderer.
 *
 * `hookToken` is a bearer credential: the hook ingress authenticates with `Bearer ${token}`
 * (agent-hook-command.ts). It is persisted in the session store, and `cloneSession` strips it on the
 * way out — every `agent-session` publication, every `list`/`get`/`resolve` return, and the runtime
 * subject projection go through it (16 call sites in client.ts). Nothing else re-checks.
 *
 * 来由（实测 2026-09-02）：脱敏那一行删掉后，core 侧 816 条全绿——没有任何断言守着它。凭据一旦进
 * 渲染层，就可能顺着 devtools、日志、崩溃报告离开本机，而这一切在测试全绿的情况下发生。
 *
 * 判据是**值**不是**属性名**：只断言 `not.toHaveProperty('hookToken')` 对「换个字段名带出去」
 * 或「塞进某个嵌套对象」完全失明。所以这里把整份公开负载序列化后搜那个 token 值本身。
 */

/** A token with the real shape: `randomBytes(32).toString('base64url')`, per agent-capability.ts:17. */
function realShapeToken(): string {
  return randomBytes(32).toString('base64url')
}

function storedSession(overrides: Partial<AgentMuxStoredAgentSession> = {}): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-session-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'run-1' },
    retiredRuns: [],
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100,
    hookBindingId: 'hook-binding-1',
    hookToken: realShapeToken(),
    ...overrides
  }
}

describe('cloneSession keeps the hook credential out of the public projection', () => {
  it('strips hookToken and hookBindingId by property', () => {
    const stored = storedSession()

    const publicSession = cloneSession(stored)

    expect(publicSession).not.toHaveProperty('hookToken')
    expect(publicSession).not.toHaveProperty('hookBindingId')
  })

  it('leaves the token value nowhere in the serialized public payload', () => {
    // 守值而非守名：一次「顺手把 token 挪到别的字段」或「留在某个嵌套结构里」的改动，
    // 上面那条按属性名的断言看不见，这条看得见。
    const token = realShapeToken()
    const stored = storedSession({ hookToken: token })

    const serialized = JSON.stringify(cloneSession(stored))

    expect(serialized).not.toContain(token)
  })

  it('still carries the public session whole, so redaction cannot be satisfied by returning less', () => {
    // 没有这条，把 cloneSession 改成 `return {} as AgentMuxAgentSession` 会让上面两条全绿——
    // 脱敏是「拿掉那两个字段」，不是「拿掉一切」。
    const stored = storedSession({
      semanticStatus: { state: 'working', source: 'native-hook', observedAt: 100, detail: 'running tests' },
      launchOptions: { sandbox: 'workspace-write' }
    })

    const publicSession = cloneSession(stored)

    const { hookBindingId: _bindingId, hookToken: _token, ...expected } = stored
    expect(publicSession).toEqual(expected)
  })

  it('does not alias the stored session, so a renderer-side mutation cannot reach the store', () => {
    // structuredClone 是这里的第二个承重点：返回 `session` 本身（或浅拷贝）会让上面三条依旧全绿，
    // 但渲染层拿到的就是 store 里那个对象。
    const stored = storedSession()

    const publicSession = cloneSession(stored)
    publicSession.run.runId = 'mutated-by-consumer'

    expect(stored.run.runId).toBe('run-1')
  })
})
