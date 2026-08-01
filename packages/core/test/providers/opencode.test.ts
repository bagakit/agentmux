import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { OPENCODE_HOOK_EVENTS, OPENCODE_HOOKS, createOpenCodeManagedHookPlan } from '../../src/providers/opencode.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-009 的 Provider 测试。
 *
 * 证据来自**上游自己的源码**：`/Users/bytedance/proj/github/opencode`（本机可读的第一方仓库）。
 * 每条断言的期望值都逐字取自那里的生成类型与加载器实现，不是从任何第三方项目的实现反推。
 *
 * 这些断言证明「声明与上游合同相符」。它**不**证明跑过一次真实 OpenCode 会话——本机没有装 opencode，
 * 事件是构造的信封，不是一个真在干活的 Agent 发出来的。不冒充。
 */
describe('OpenCode provider', () => {
  const providers = new AgentProviderRegistry()
  const opencode = providers.get('opencode')
  const endpoint = { url: 'http://127.0.0.1:8765/v1/events', token: 'tok-opencode-1' }

  /**
   * 造一条 OpenCode 形状的信封。
   *
   * 负载键是 **`sessionID`（大写 ID）**——上游全库统一如此（`types.gen.ts:470,479`）。
   * `runId` 逐用例区分：normalizer 的子代理花名册是按 runId 索引的模块级可变状态。
   */
  function hookIn(runId: string) {
    return (eventName: string, payload: Record<string, unknown> = {}) =>
      opencode.normalizeHook({
        receiptId: `r-${runId}-${eventName}`,
        agentSessionId: 's-opencode',
        runId,
        providerId: 'opencode',
        eventName,
        payload: { sessionID: 'opencode-session-1', ...payload }
      })
  }

  describe('事件名逐字来自上游生成类型，不做翻译', () => {
    it('装的七个全部是上游的真名——带点号的小写，没有一个合成的 PascalCase', () => {
      // 上游的事件名形如 `session.idle`（`types.gen.ts:704-736` 的联合体）。参考实现会把它们改写成
      // `SessionIdle` 这类合成名再投递；本仓透传真名，SSOT 因此直接落在上游类型上。
      // 若哪天有人"顺手"改成 PascalCase，这条会红。
      for (const name of OPENCODE_HOOK_EVENTS) {
        expect(name).toMatch(/^[a-z]+(\.[a-z.]+)+$/)
      }
      expect([...OPENCODE_HOOK_EVENTS]).toEqual([
        'session.status', 'session.idle', 'message.part.updated',
        'permission.updated', 'permission.replied', 'session.compacted', 'session.error'
      ])
    })

    it('绝不含任何一个别家 Provider 的拼法', () => {
      // 别家的收尾拼法：Claude 的 `Stop`、Copilot 的 `agentStop`、grok 的 `stop_cancelled`、
      // Pi 的 `agent_end`。照抄任何一个都会静默失配——上游不认识的名字不会报错，只是永远不到。
      const foreign = ['Stop', 'agentStop', 'stop_cancelled', 'agent_end', 'SessionStart', 'SessionIdle']
      for (const name of foreign) {
        expect([...OPENCODE_HOOK_EVENTS]).not.toContain(name)
      }
    })
  })

  describe('done 挂在两个名字上——因为上游把一次空闲发成两条，且其中一条已废弃', () => {
    it('session.status 与 session.idle 都判 done', () => {
      // 上游 `session/status.ts:41-45`：先发 `session.status`，若 `status.type==='idle'` 再发
      // `session.idle`。两条**总是成对到达**。
      const emit = hookIn('run-done')
      expect(emit('session.status', { status: { type: 'idle' } }).semanticState).toBe<AgentSemanticState>('done')
      expect(emit('session.idle').semanticState).toBe<AgentSemanticState>('done')
    })

    it('只押已废弃的 session.idle 是不够的——它随时可能消失', () => {
      // `packages/schema/src/session-status-event.ts:43` 那行逐字 `// deprecated` 标在 `Idle` 上。
      // 这条断言的意义：如果有人把 rules 收敛成只认 `session.idle`，上游删掉它的那天 done 会静默
      // 消失（会话永远停在 working）。所以 `session.status` 必须独立地也判 done。
      const statusRule = OPENCODE_HOOKS.rules.find((rule) => rule.events.includes('session.status'))
      expect(statusRule?.state).toBe<AgentSemanticState>('done')
      const idleRule = OPENCODE_HOOKS.rules.find((rule) => rule.events.includes('session.idle'))
      expect(idleRule?.state).toBe<AgentSemanticState>('done')
    })

    it('流式输出判 working——它把一轮开头 session.status(busy) 的误判覆盖回去', () => {
      // 已知代价：规则只按事件名匹配（`hook-normalizer.ts:187-198` 除 toolNames 外不读负载），
      // 所以 `session.status` 带 `busy` 时也会被判 done。真实时序是
      // status(busy) → 一串 part.updated → status(idle)+idle，中间的 part.updated 会把状态拉回
      // working，收尾那次才是最终态。这条钉住那个"拉回来"的能力。
      const emit = hookIn('run-stream')
      expect(emit('session.status', { status: { type: 'busy' } }).semanticState).toBe<AgentSemanticState>('done')
      expect(emit('message.part.updated', { part: { id: 'p1' } }).semanticState).toBe<AgentSemanticState>('working')
    })
  })

  describe('授权门判 waiting，回复判 working', () => {
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
    const plan = createOpenCodeManagedHookPlan(endpoint.url, endpoint.token)

    it('内容是可被 import 的 ESM，且只导出一个函数', () => {
      // 上游加载器对模块的**每个**导出取值判定，任何一个非函数导出都会让整个模块抛
      // `"Plugin export is not a function"`（`plugin/index.ts:99-112`）。所以这份源码只能导出
      // 一个具名函数 `server`，顺手导出一个常量就会让整个插件加载失败。
      const content = plan.mutations[0]?.content ?? ''
      expect(content).toContain('export async function server()')
      const exports = [...content.matchAll(/^export\s+(?:async\s+)?(\w+)/gm)].map((match) => match[1])
      expect(exports).toEqual(['function'])
    })

    it('这是本仓第一份非 shell 的 hook 内容——绝不含 shell 命令的痕迹', () => {
      // 其余九家写的是 `ELECTRON_RUN_AS_NODE=1 ... agentmux-hook.js` 这样一条命令。这条钉住
      // opencode 走的是另一条路：若有人"照着别家改"，把它换回 managedHookCommand()，这条会红。
      const content = plan.mutations[0]?.content ?? ''
      expect(content).not.toContain('ELECTRON_RUN_AS_NODE')
      expect(content).not.toContain('agentmux-hook.js')
    })

    it('endpoint 与 token 内联在文件里——插件进程看不到 PTY 环境变量', () => {
      const content = plan.mutations[0]?.content ?? ''
      expect(content).toContain(JSON.stringify(endpoint.url))
      expect(content).toContain(JSON.stringify(endpoint.token))
      // 且不能退化成读环境变量：插件跑在 OpenCode 自己的进程里，那里没有这两个变量。
      expect(content).not.toContain('AGENTMUX_HOOK_URL')
      expect(content).not.toContain('AGENTMUX_HOOK_TOKEN')
    })

    it('投递的信封与那九家 shell hook 完全同形', () => {
      // 服务端从 token 绑定反查 providerId/runId/agentSessionId（`hook-server.ts:302-304`），
      // 不从正文取，所以插件必须发且只发这三个字段。
      const content = plan.mutations[0]?.content ?? ''
      expect(content).toContain('receiptId')
      expect(content).toContain('eventName')
      expect(content).toContain('payload')
      expect(content).toContain("'Bearer '")
    })

    it('只投递声明过的那七个事件', () => {
      // 上游会把**所有**类型的事件推给插件（`plugin/index.ts:255-262` 只按目录过滤）。不筛的话
      // 每次 keystroke 级的 part 更新之外还会灌进 lsp/file/pty 等一大批无关事件。
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
      // 自动发现的 glob 是 `{plugin,plugins}/*.{ts,js}`（`config/plugin.ts:21`）。
      const plan = createOpenCodeManagedHookPlan(endpoint.url, endpoint.token, {
        OPENCODE_CONFIG_DIR: '/tmp/oc-config'
      })
      expect(plan.mutations[0]?.path).toBe('/tmp/oc-config/plugin/agentmux.js')
      expect(plan.mutations[0]?.mode).toBe(0o600)
    })

    it('OPENCODE_CONFIG_DIR 被尊重，空串等于没设', () => {
      const withEmpty = createOpenCodeManagedHookPlan(endpoint.url, endpoint.token, { OPENCODE_CONFIG_DIR: '  ' })
      expect(withEmpty.mutations[0]?.path).not.toContain('  ')
    })

    it('XDG_CONFIG_HOME 决定默认目录', () => {
      // 上游 `global.ts:13`：`Path.config = join(xdgConfig, 'opencode')`。
      const plan = createOpenCodeManagedHookPlan(endpoint.url, endpoint.token, { XDG_CONFIG_HOME: '/tmp/xdg' })
      expect(plan.mutations[0]?.path).toBe('/tmp/xdg/opencode/plugin/agentmux.js')
    })

    it('绝不装到项目级 .opencode/——那会被提交进用户仓库', () => {
      // 上游也扫项目级与 home 下的 `.opencode/`（`config/paths.ts:23-41`）。只装全局一处。
      const plan = createOpenCodeManagedHookPlan(endpoint.url, endpoint.token, { OPENCODE_CONFIG_DIR: '/tmp/oc' })
      expect(plan.mutations[0]?.path).not.toContain('.opencode')
    })

    it('装的位置与 workspace 无关', () => {
      const a = resolveManagedHookPlan('opencode', '/repo/a', {}, endpoint)
      const b = resolveManagedHookPlan('opencode', '/repo/b', {}, endpoint)
      expect(a?.mutations[0]?.path).toBe(b?.mutations[0]?.path)
    })
  })

  describe('catalog 如实声明它有的和没有的', () => {
    it('native handle 读大写 sessionID——读 sessionId 会取不到', () => {
      const event = hookIn('run-handle')('session.idle')
      expect(event.nativeHandle?.sessionId).toBe('opencode-session-1')
      // 反证：小写拼法的负载给不出 handle。这条防的是"看起来对"的拼写漂移。
      const wrong = opencode.normalizeHook({
        receiptId: 'r-wrong', agentSessionId: 's', runId: 'run-wrong',
        providerId: 'opencode', eventName: 'session.idle',
        payload: { sessionId: 'lowercase-id' }
      })
      expect(wrong.nativeHandle?.sessionId).toBeUndefined()
    })

    it('不声明 transcriptPath——上游没有单文件 transcript', () => {
      // `storage.ts:150-196` 把会话拆成 session/message/part 三组存储键，没有任何事件负载带得出
      // 一条可读路径。声明一个取不到的键等于让 handle 永远缺一半。
      expect(OPENCODE_HOOKS.nativeHandle?.transcriptPathKeys).toBeUndefined()
    })

    it('不声明子代理记账——上游 28 个事件里没有子代理起止', () => {
      // 声明一个不存在的记账会让 applySubagentTracking 永远等一个不会到来的 stop，把 done 压死。
      expect(OPENCODE_HOOKS.subagentTracking).toBeUndefined()
    })

    it('resume 走 --session，不走 --resume 也不走 --continue', () => {
      // `cli/cmd/run.ts:152-156`：`--session`（别名 `-s`）"session id to continue"。
      // **没有 `--resume`**——照别家拼法猜一个会直接报未知参数。
      const launch = opencode.buildResumeLaunch({
        workspacePath: '/repo',
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
        args: [], workspacePath: '/repo', env: {}
      })).toThrowError(/does not belong to this provider/)
    })

    it('acp 与 usage 都不声明', () => {
      expect(opencode.catalog.acpStrategy).toEqual({ kind: 'none' })
      expect(opencode.catalog.capabilities.usage).toBeUndefined()
      expect(opencode.catalog.capabilities.replyCorrelation).toBe('none')
    })
  })
})
