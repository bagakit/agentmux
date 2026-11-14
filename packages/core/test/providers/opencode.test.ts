import { fixturePath } from '../helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, type AgentProviderHookNormalizationContext } from '../../src/agent-provider.js'
import { OPENCODE_HOOK_EVENTS, OPENCODE_HOOKS, createOpenCodeManagedHookPlan } from '../../src/providers/opencode.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-009 / T-039 的 Provider 测试。
 *
 * 证据来自上游自己的源码：home//proj/github/opencode（df35e842f59bc115bb7c0479a8e11f017d443f2c）。
 * 每条断言的期望值都逐字取自那里的生成类型与加载器实现，不是从任何第三方项目的实现反推。
 */
describe('OpenCode provider', () => {
  const providers = new AgentProviderRegistry()
  const opencode = providers.get('opencode')
  const endpoint = { url: 'http://127.0.0.1:8765/v1/events', token: 'tok-opencode-1' }

  /**
   * 造一条 OpenCode 形状的信封。
   *
   * 负载键是 **`sessionID`（大写 ID）**——上游全库统一如此（`types.gen.ts:470,479`）。
   * `runId` 逐用例区分：每条信封沿自己的 Run 身份参与归一化，不共享可变花名册。
   */
  function hookIn(
    runId: string,
    context: AgentProviderHookNormalizationContext = {
      nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'opencode-session-1' }
    }
  ) {
    return (eventName: string, payload: Record<string, unknown> = {}) =>
      opencode.normalizeHook({
        receiptId: `r-${runId}-${eventName}`,
        agentSessionId: 's-opencode',
        runId,
        providerId: 'opencode',
        eventName,
        payload: { sessionID: 'opencode-session-1', ...payload }
      }, context)
  }

  describe('事件名逐字来自上游生成类型，不做翻译', () => {
    it('装的全部是上游的真名——带点号的小写，没有一个合成的 PascalCase', () => {
      for (const name of OPENCODE_HOOK_EVENTS) {
        expect(name).toMatch(/^[a-z]+(\.[a-z.]+)+$/)
      }
      expect([...OPENCODE_HOOK_EVENTS]).toEqual([
        'session.status', 'session.idle', 'message.part.updated',
        'permission.updated', 'permission.replied', 'session.compacted', 'session.error'
      ])
    })

    it('绝不含任何一个别家 Provider 的拼法', () => {
      const foreign = ['Stop', 'agentStop', 'stop_cancelled', 'agent_end', 'SessionStart', 'SessionIdle']
      for (const name of foreign) {
        expect([...OPENCODE_HOOK_EVENTS]).not.toContain(name)
      }
    })
  })

  describe('session.status 使用 payload status.type 匹配，不把 busy/retry/idle 误判为 done', () => {
    it('session.status 带 idle 保持中性 unknown，不发出 turn-end (idle 无确定 outcome)', () => {
      const emit = hookIn('run-done')
      const result = emit('session.status', { status: { type: 'idle' } })
      expect(result.semanticState).toBe<AgentSemanticState>('unknown')
      expect(result.lifecycleEvent ?? null).toBeNull()
    })

    it('session.status 带 busy 判 working 并发出 turn-start (可重开 turn)', () => {
      const emit = hookIn('run-busy')
      const result = emit('session.status', { status: { type: 'busy' } })
      expect(result.semanticState).toBe<AgentSemanticState>('working')
      expect(result.lifecycleEvent).toBe('turn-start')
    })

    it('session.status 带 retry 判 working (进行中重试，不重开 turn)', () => {
      const emit = hookIn('run-retry')
      const result = emit('session.status', { status: { type: 'retry', attempt: 1 } })
      expect(result.semanticState).toBe<AgentSemanticState>('working')
      expect(result.lifecycleEvent).toBeUndefined()
    })

    it('session.status 缺失 status 或未知 type 保持 unknown', () => {
      const emit = hookIn('run-missing')
      expect(emit('session.status', {}).semanticState).toBe<AgentSemanticState>('unknown')
      expect(emit('session.status', { status: { type: 'mysterious' } }).semanticState).toBe<AgentSemanticState>('unknown')
    })
  })

  describe('授权门与人机问题判 waiting，回复判 working', () => {
    it('permission.updated 判 waiting——Agent 正卡在一个决定上', () => {
      const emit = hookIn('run-perm')
      expect(emit('permission.updated', { id: 'perm-1', title: 'Run command' }).semanticState)
        .toBe<AgentSemanticState>('waiting')
    })

    it('permission.replied 判 working 而不是第二种收尾——决定给出后执行继续', () => {
      const emit = hookIn('run-perm2')
      expect(emit('permission.replied', { permissionID: 'perm-1', response: 'once' }).semanticState)
        .toBe<AgentSemanticState>('working')
    })


  })

  describe('声明与安装必须一致', () => {
    it('rules 引用的每个事件都在安装清单里', () => {
      const installed = new Set<string>(OPENCODE_HOOK_EVENTS)
      for (const rule of OPENCODE_HOOKS.rules) {
        for (const event of rule.events) expect(installed.has(event)).toBe(true)
      }
    })

    it('装的每个事件都被某条 rule 判过——装了不判等于白投递一条', () => {
      const judged = new Set(OPENCODE_HOOKS.rules.flatMap((rule) => [...rule.events]))
      for (const event of OPENCODE_HOOK_EVENTS) expect(judged.has(event)).toBe(true)
    })

    it('未装的事件到达时保持可诊断，绝不伪造状态', () => {
      const emit = hookIn('run-unknown')
      expect(emit('session.deleted').semanticState).toBe<AgentSemanticState>('unknown')
    })
  })

  describe('装的是 JS 插件文件，不是 shell 命令', () => {
    const plan = createOpenCodeManagedHookPlan()

    it('内容是可被 import 的 ESM，且只导出一个函数', () => {
      const content = plan.mutations[0]?.content ?? ''
      expect(content).toContain('export async function server()')
      const exports = [...content.matchAll(/^export\s+(?:async\s+)?(\w+)/gm)].map((match) => match[1])
      expect(exports).toEqual(['function'])
    })

    it('这是本仓第一份非 shell 的 hook 内容——绝不含 shell 命令的痕迹', () => {
      const content = plan.mutations[0]?.content ?? ''
      expect(content).not.toContain('ELECTRON_RUN_AS_NODE')
      expect(content).not.toContain('agentmux-hook.js')
    })

    it('共享源码不内联任何 Run 凭证；原生本地 Worker 从自己的环境取得绑定', () => {
      const content = plan.mutations[0]?.content ?? ''
      expect(content).not.toContain(JSON.stringify(endpoint.url))
      expect(content).not.toContain(JSON.stringify(endpoint.token))
      expect(content).toContain('AGENTMUX_HOOK_URL')
      expect(content).toContain('AGENTMUX_HOOK_TOKEN')
    })

    it('投递的信封与那九家 shell hook 完全同形', () => {
      const content = plan.mutations[0]?.content ?? ''
      expect(content).toContain('receiptId')
      expect(content).toContain('eventName')
      expect(content).toContain('payload')
      expect(content).toContain('Bearer ${token}')
    })

    it('只投递声明过的事件', () => {
      const content = plan.mutations[0]?.content ?? ''
      for (const name of OPENCODE_HOOK_EVENTS) expect(content).toContain(JSON.stringify(name))
      expect(content).toContain('events.has(event.type)')
    })

    it('投递失败被整体吞掉——绝不打断用户的会话', () => {
      const content = plan.mutations[0]?.content ?? ''
      expect(content).toContain('catch')
    })
  })

  describe('装到上游真的会扫的位置', () => {
    it('装到 <config-dir>/plugin/agentmux.js', () => {
      const plan = createOpenCodeManagedHookPlan({
        OPENCODE_CONFIG_DIR: fixturePath("tmp/oc-config")
      })
      expect(plan.mutations[0]?.path).toBe(fixturePath("tmp/oc-config/plugin/agentmux.js"))
      expect(plan.mutations[0]?.mode).toBe(0o600)
    })

    it('OPENCODE_CONFIG_DIR 被尊重，空串等于没设', () => {
      const withEmpty = createOpenCodeManagedHookPlan({ OPENCODE_CONFIG_DIR: '  ' })
      expect(withEmpty.mutations[0]?.path).not.toContain('  ')
    })

    it('XDG_CONFIG_HOME 决定默认目录', () => {
      const plan = createOpenCodeManagedHookPlan({ XDG_CONFIG_HOME: fixturePath("tmp/xdg") })
      expect(plan.mutations[0]?.path).toBe(fixturePath("tmp/xdg/opencode/plugin/agentmux.js"))
    })

    it('绝不装到项目级 .opencode/——那会被提交进用户仓库', () => {
      const plan = createOpenCodeManagedHookPlan({ OPENCODE_CONFIG_DIR: fixturePath("tmp/oc") })
      expect(plan.mutations[0]?.path).not.toContain('.opencode')
    })

    it('装的位置与 workspace 无关', () => {
      const a = (new AgentProviderRegistry().get('opencode').planManagedHooks?.({ workspacePath: fixturePath("repo/a"), env: {}, endpoint: endpoint }) ?? null)
      const b = (new AgentProviderRegistry().get('opencode').planManagedHooks?.({ workspacePath: fixturePath("repo/b"), env: {}, endpoint: endpoint }) ?? null)
      expect(a?.mutations[0]?.path).toBe(b?.mutations[0]?.path)
    })
  })

  describe('catalog 如实声明它有的和没有的', () => {
    it('native handle 读大写 sessionID 并在可信 context 匹配时交付 handle', () => {
      const event = hookIn('run-handle')('session.idle')
      expect(event.nativeHandle?.sessionId).toBe('opencode-session-1')
      // 反证：小写拼法的负载给不出 handle。这条防的是"看起来对"的拼写漂移。
      const wrong = opencode.normalizeHook({
        receiptId: 'r-wrong', agentSessionId: 's', runId: 'run-wrong',
        providerId: 'opencode', eventName: 'session.idle',
        payload: { sessionId: 'lowercase-id' }
      }, { nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'opencode-session-1' } })
      expect(wrong.nativeHandle?.sessionId).toBeUndefined()
    })

    it('不声明 transcriptPath——上游没有单文件 transcript', () => {
      expect(OPENCODE_HOOKS.nativeHandle?.transcriptPathKeys).toBeUndefined()
    })

    it('不声明子代理记账——上游 28 个事件里没有子代理起止', () => {
      expect(OPENCODE_HOOKS.subagentTracking).toBeUndefined()
    })

    it('resume 走 --session，不走 --resume 也不走 --continue', () => {
      const launch = opencode.buildResumeLaunch({
        workspacePath: fixturePath("repo"),
        nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'sess-9' },
        prompt: 'go on',
        args: [],
        env: {}
      })
      expect(launch.args).toContain('--session')
      expect(launch.args).toContain('sess-9')
      expect(launch.args).not.toContain('--resume')
      expect(launch.args).not.toContain('--continue')
    })

    it('别家的 native handle 恢复不了——两类失败必须可区分', () => {
      expect(() => opencode.buildResumeLaunch({
        nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 's-1' },
        args: [], workspacePath: fixturePath("repo"), env: {}
      })).toThrowError(/does not belong to this provider/)
    })

    it('acp 与 usage 都不声明', () => {
      expect(opencode.catalog.acpStrategy).toEqual({ kind: 'none' })
      expect(opencode.catalog.capabilities.usage).toBeUndefined()
      expect(opencode.catalog.capabilities.replyCorrelation).toBe('none')
    })
  })

  describe('可信 Session 上下文与根/子隔离', () => {
    it('明确子会话（parentID）被严格隔离：不晋升 handle、不推进 turn、中性 unknown', () => {
      const emit = hookIn('run-child')
      const child = emit('session.status', { parentID: 'root-sess-1', status: { type: 'busy' } })
      expect(child.nativeHandle).toBeUndefined()
      expect(child.lifecycleEvent).toBeNull()
      expect(child.semanticState).toBe('unknown')
      expect(child.status.state).toBe('running')
    })

    it('明确子会话（info.parentID）同样被严格隔离', () => {
      const emit = hookIn('run-child-info')
      const child = emit('session.status', { info: { parentID: 'root-sess-1' }, status: { type: 'busy' } })
      expect(child.nativeHandle).toBeUndefined()
      expect(child.lifecycleEvent).toBeNull()
      expect(child.semanticState).toBe('unknown')
      expect(child.status.state).toBe('running')
    })

    it('主 Agent 调用 task 工具保留主会话身份与原状态，不凭工具名推断子会话', () => {
      const emit = hookIn('run-root-task')
      const taskEvent = emit('message.part.updated', {
        part: { type: 'tool', tool: 'task', callID: 'call-1', state: { status: 'running' } }
      })
      expect(taskEvent.nativeHandle?.sessionId).toBe('opencode-session-1')
      expect(taskEvent.lifecycleEvent).toBeUndefined()
      expect(taskEvent.timeline.length).toBeGreaterThan(0)
      expect(taskEvent.semanticState).toBe('working')
    })

    it('外部会话（sessionID 与 context.nativeHandle 不匹配）被严格隔离', () => {
      const emit = hookIn('run-foreign')
      const foreign = emit('session.status', { sessionID: 'foreign-session-2', status: { type: 'busy' } })
      expect(foreign.nativeHandle).toBeUndefined()
      expect(foreign.lifecycleEvent).toBeNull()
      expect(foreign.semanticState).toBe('unknown')
      expect(foreign.status.state).toBe('running')
    })

    it('context.nativeHandle 缺失时（未知归属），保非空 trace 但不猜 root、不推进主生命周期', () => {
      const emit = hookIn('run-fresh', {})
      const fresh = emit('session.status', { status: { type: 'busy' } })
      expect(fresh.nativeHandle).toBeUndefined()
      expect(fresh.lifecycleEvent).toBeNull()
      expect(fresh.semanticState).toBe('unknown')
      expect(fresh.status.state).toBe('running')
      expect(fresh.timeline.length).toBeGreaterThan(0)
    })

    it('子会话被严格隔离时，剥除 turnUsage 与 interaction，不影响主会话用量与交互', () => {
      const emit = hookIn('run-child-clean')
      const child = emit('permission.updated', {
        sessionID: 'sub-1',
        parentID: 'opencode-session-1',
        id: 'per-child',
        permission: 'bash'
      })
      expect(child.nativeHandle).toBeUndefined()
      expect(child.lifecycleEvent).toBeNull()
      expect(child.semanticState).toBe('unknown')
      expect(child.interaction).toBeUndefined()
      expect(child.turnUsage).toBeUndefined()
    })
  })
})
