import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { PI_HOOK_EVENTS, PI_HOOKS, createPiManagedHookPlan } from '../../src/providers/pi.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-005 的 Provider 测试。
 *
 * 证据来自**上游自己的源码**：`/Users/bytedance/proj/github/pi`（即 `earendil-works/pi`，本机可读的
 * 第一方仓库）。每条断言的期望值都逐字取自那里的类型声明与加载器实现，不是从任何第三方项目的实现反推。
 *
 * 这些断言证明「声明与上游合同相符」。它**不**证明跑过一次真实 Pi 会话——本机没有装 pi，事件是构造的
 * 信封，不是一个真在干活的 Agent 发出来的。不冒充。
 */
describe('Pi provider', () => {
  const providers = new AgentProviderRegistry()
  const pi = providers.get('pi')

  /**
   * 造一条 Pi 形状的信封。
   *
   * 默认带齐 `session_id` 与 `session_file`——`requireTranscriptPath` 为真，缺 session_file 时整个
   * handle 会被丢弃，那是另一组用例专门守的事。
   */
  function hookIn(runId: string) {
    return (eventName: string, payload: Record<string, unknown> = {}) =>
      pi.normalizeHook({
        receiptId: `r-${runId}-${eventName}`,
        agentSessionId: 's-pi',
        runId,
        providerId: 'pi',
        eventName,
        payload: { session_id: 'pi-session-1', session_file: '/tmp/pi/2026.jsonl', ...payload }
      })
  }

  describe('事件名逐字来自上游的 on() 重载', () => {
    it('订阅的七个都是 snake_case 真名，没有一个别家的拼法', () => {
      // 上游的事件名形如 `agent_settled`（`extensions/types.ts:1282-1298` 的 on() 重载签名）。
      for (const name of PI_HOOK_EVENTS) {
        expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/)
      }
      expect([...PI_HOOK_EVENTS]).toEqual([
        'before_agent_start', 'agent_start', 'tool_call', 'tool_execution_start',
        'tool_execution_end', 'message_end', 'agent_settled'
      ])
    })

    it('绝不含任何一个别家 Provider 的拼法', () => {
      // 别家的收尾/起始拼法：Claude 的 `Stop`/`SessionStart`、Copilot 的 `agentStop`、
      // grok 的 `stop_cancelled`、OpenCode 的 `session.idle`。照抄任何一个都会静默失配——
      // Pi 的 on() 只认它自己声明过的名字。
      const foreign = ['Stop', 'agentStop', 'stop_cancelled', 'session.idle', 'SessionStart', 'PreToolUse']
      for (const name of foreign) {
        expect([...PI_HOOK_EVENTS]).not.toContain(name)
      }
    })
  })

  /**
   * 这一组是本轮读第一方源码翻出来的实锤，也是这个 Provider 最容易被改回去的地方。
   */
  describe('agent_settled 是唯一的 done——agent_end 不是', () => {
    it('agent_settled 判 done', () => {
      // 上游只在 `_handlePostAgentRun` 的 while 循环整个跑完后、在 finally 里发一次
      // （`agent-session.ts:1109-1117`）。它自己的 RPC 客户端也是等这一条才认为调用结束
      // （`modes/rpc/rpc-client.ts:462`）。
      expect(hookIn('run-settled')('agent_settled').semanticState).toBe<AgentSemanticState>('done')
    })

    it('agent_end 绝不判 done——它之后还有 retry / compaction / queued 三条续跑路径', () => {
      // `agent-session.ts:1121-1149`：`_handlePostAgentRun` 返回 true 就 `agent.continue()` 再来一轮。
      // 三条路径分别是 :1128 可重试错误、:1142 自动压缩、:1148 handler 排队的消息。
      //
      // 这条是**方向性**断言，不是"没订阅所以不会到"：就算它到了（比如别处误投），也绝不能判 done。
      // 把 PI_HOOKS 的 done 规则改成 `['agent_end', 'agent_settled']`（也就是改回本轮之前的样子），
      // 这条立刻红。
      expect(hookIn('run-end')('agent_end').semanticState).not.toBe<AgentSemanticState>('done')
    })

    it('done 规则只挂着 agent_settled 一个名字', () => {
      // 上一条守"agent_end 不是 done"，这条守"没有第三个名字偷偷也判 done"。两条方向不同：
      // 只有前者时，往 done 规则里加 `message_end` 不会红。
      const doneEvents = PI_HOOKS.rules.filter((rule) => rule.state === 'done').flatMap((rule) => [...rule.events])
      expect(doneEvents).toEqual(['agent_settled'])
    })

    it('干活中的六个事件都判 working，一个都不落', () => {
      const emit = hookIn('run-working')
      for (const name of ['before_agent_start', 'agent_start', 'tool_call',
        'tool_execution_start', 'tool_execution_end', 'message_end']) {
        expect(emit(name, { tool_name: 'bash' }).semanticState).toBe<AgentSemanticState>('working')
      }
    })
  })

  /**
   * 删掉的那条 blocked 规则不能被"顺手"加回来。
   */
  describe('没有 blocked/waiting 规则——Pi 里没有对应的工具，也没有对应的事件', () => {
    it('规则表里一条 blocked 或 waiting 都没有', () => {
      // 此前有一条按 `ask_user_question`/`askuserquestion` 判 blocked 的规则，押的工具在 Pi 里
      // **根本不存在**：内置工具就是 bash/edit/find/grep/ls/powershell/read/write 八个
      // （`core/tools/` 目录）。仓库里 `AskUserQuestion` 的出现全在一张 **Claude Code** 的工具名
      // 映射表里（`packages/ai/src/api/anthropic-messages.ts:89`），与 Pi 自己的工具集无关。
      const gated = PI_HOOKS.rules.filter((rule) => rule.state === 'blocked' || rule.state === 'waiting')
      expect(gated).toEqual([])
    })

    it('喂一个 ask_user_question 的 tool_call 进去，判的是 working 而不是 blocked', () => {
      // 行为侧的同一条。上一条守规则表的形状，这条守实际判定——只守形状时，有人把 blocked 写进
      // 一条 events 更宽的规则里仍可能绕过去。
      const event = hookIn('run-ask')('tool_call', { tool_name: 'ask_user_question' })
      expect(event.semanticState).toBe<AgentSemanticState>('working')
    })

    it('catalog 的 permission 记 none 而不是 observe', () => {
      // Pi 没有任何可订阅的授权事件（`types.ts` 里没有 permission 族），`ui_prompt_start`/`ui_prompt_end`
      // 只在**扩展自己**调 `ctx.ui.*` 弹窗时发（`extensions/runner.ts:441-480`），与 Agent 自身的权限
      // 提示无关。声明 observe 会是一句"我们看得见它在等人"的谎。
      expect(pi.catalog.capabilities.permission).toBe('none')
    })
  })

  describe('native handle：session_file 缺席时整个 handle 不成立', () => {
    it('两个字段齐全时给出带 transcriptPath 的 handle', () => {
      const event = hookIn('run-handle')('agent_start')
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'pi',
        sessionId: 'pi-session-1',
        transcriptPath: '/tmp/pi/2026.jsonl'
      })
    })

    it('只有 session_id 时 handle 整个缺席——不给一个 resume 用不了的半成品', () => {
      // `requireTranscriptPath: true`。这与扩展侧「transcript 真落盘后才报 session_file」是同一个
      // 约束的两端：上游在会话创建时就返回路径（`session-manager.ts:954`），但文件要等第一条
      // assistant 消息才创建（`:1031` 的 `openSync(..., "wx")`）。
      const event = pi.normalizeHook({
        receiptId: 'r-no-file',
        agentSessionId: 's-pi',
        runId: 'run-no-file',
        providerId: 'pi',
        eventName: 'agent_start',
        payload: { session_id: 'pi-session-1' }
      })
      expect(event.nativeHandle).toBeUndefined()
    })
  })

  describe('resume 走 --session <transcript 路径>', () => {
    it('拿到 transcriptPath 时组出 --session 加那个路径', () => {
      // `cli/args.ts:123-124` 解析 `--session <value>`，`main.ts:385-391` 把它当路径解析后打开。
      const launch = pi.buildResumeLaunch({
        workspacePath: '/tmp/ws',
        nativeHandle: {
          kind: 'provider',
          providerId: 'pi',
          sessionId: 'pi-session-1',
          transcriptPath: '/tmp/pi/2026.jsonl'
        },
        args: [],
        env: {}
      })
      expect(launch.command).toBe('pi')
      expect(launch.args).toEqual(['--session', '/tmp/pi/2026.jsonl'])
      // **不是** `--session-id`：那个是给会话取 id（`cli/args.ts:125-126`），不是恢复。
      expect(launch.args).not.toContain('--session-id')
      expect(launch.args).not.toContain('--resume')
    })

    it('缺 transcriptPath 时抛，且 detail 指得出该等什么', () => {
      let thrown: unknown
      try {
        pi.buildResumeLaunch({
          workspacePath: '/tmp/ws',
          nativeHandle: { kind: 'provider', providerId: 'pi', sessionId: 'pi-session-1' },
          args: [],
          env: {}
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AgentMuxError)
      expect((thrown as AgentMuxError).code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      // 与「handle 属于别的 Provider」共用错误码，所以 detail 必须分得清是哪一种。
      expect((thrown as AgentMuxError).detail).toContain('missingField=transcriptPath')
    })
  })

  /**
   * 装载合同。每一条猜错都是静默失败：Pi 不会因为扩展形状不对而报错，只会跳过它。
   */
  describe('managed 扩展的安装合同', () => {
    const plan = createPiManagedHookPlan({ PI_CODING_AGENT_DIR: '/tmp/pi-agent-dir' })
    const mutation = plan.mutations[0]!

    it('装到 <agent-dir>/extensions/ 下的一个 .js 文件', () => {
      // `loader.ts:784` 的 globalExtDir = `<agentDir>/extensions`；`isExtensionFile`（`:666-668`）
      // 收 `.ts` 与 `.js`，一层目录直接命中（`:735-737`）。
      expect(plan.providerId).toBe('pi')
      expect(plan.mutations).toHaveLength(1)
      expect(mutation.path).toBe('/tmp/pi-agent-dir/extensions/agentmux.js')
    })

    it('尊重 PI_CODING_AGENT_DIR，缺席时落到 ~/.pi/agent/extensions', () => {
      // `getAgentDir()`（`config.ts:524-530`）：先读 env，否则 `~/<CONFIG_DIR_NAME>/agent`，
      // 而 `CONFIG_DIR_NAME` 缺省 `.pi`（`config.ts:500`）。
      const fallback = createPiManagedHookPlan({})
      expect(fallback.mutations[0]!.path).toMatch(/\/\.pi\/agent\/extensions\/agentmux\.js$/)
      expect(fallback.mutations[0]!.path).not.toContain('/tmp/pi-agent-dir')
    })

    it('绝不跨家兜底——同族其它 agent 的目录变量对 Pi 完全无效', () => {
      // Pi 系三家（Pi / OMP / Prime）共用同一套扩展 API 与目录合同，只有 env 名与默认目录名不同
      // （上游把它做成 package.json 的 `piConfig`，见 `config.ts:500-504`）。正因为长得一样，
      // 「Pi 的变量没设就顺手用同族另一家的」是个极自然的写法——而它会把 AgentMux 的扩展装进
      // 另一家的加载路径里，同时遮蔽那一家的用户扩展，两边都毫无征兆。
      //
      // 实测过：给 `piFamilyExtensionDir` 加一句 `?? env?.OMP_CODING_AGENT_DIR?.trim()`，
      // 35 条断言一条都不红。所以这条必须显式钉住——只认自己那一个变量名。
      const crossFamily = createPiManagedHookPlan({
        OMP_CODING_AGENT_DIR: '/tmp/omp-agent-dir',
        PRIME_AGENT_CODING_AGENT_DIR: '/tmp/prime-agent-dir'
      })
      expect(crossFamily.mutations[0]!.path).not.toContain('/tmp/omp-agent-dir')
      expect(crossFamily.mutations[0]!.path).not.toContain('/tmp/prime-agent-dir')
      // 自己的变量缺席时走自己的默认值，而不是借用别家的。
      expect(crossFamily.mutations[0]!.path).toMatch(/\/\.pi\/agent\/extensions\/agentmux\.js$/)
    })

    it('导出的是 default 函数，不是具名导出', () => {
      // `loader.ts:510-514`：`jiti.import(path, { default: true })` 后判 `typeof factory !== "function"`,
      // 不是函数就整个模块被跳过。注意与 opencode 相反——那边要的是具名 `server` 导出，照抄会静默失效。
      expect(mutation.content).toContain('export default function (pi)')
      expect(mutation.content).not.toContain('export async function server')
    })

    it('写出去的是 JS，不是 shell 命令', () => {
      // 其余九家写的是一条 shell 命令（`managedHookCommand()` 那条 ELECTRON_RUN_AS_NODE=1 ...）。
      // Pi 没有那条通路：它的扩展面就是 in-process JS。
      expect(mutation.content).not.toContain('ELECTRON_RUN_AS_NODE')
      expect(mutation.content).toContain("pi.on('agent_settled'")
    })

    it('七个订阅的事件名逐个出现在源码里，一个不少', () => {
      // 守的是「声明的清单」与「真写进文件的注册」不漂移——两份东西分居两处，改一处忘另一处不会红。
      for (const name of PI_HOOK_EVENTS) {
        expect(mutation.content).toContain(`pi.on('${name}'`)
      }
    })

    it('刻意不订阅 agent_end', () => {
      // 它在 agent_settled 之前必然发生且语义已被 working 覆盖，订阅它只是多一条投递。
      // 更要紧的是：谁把它加回来并顺手判 done，上面那组 done 断言就会红。
      expect(mutation.content).not.toContain("pi.on('agent_end'")
    })

    it('token 与 URL 在运行时从环境变量取，一个字节都不落盘', () => {
      // 这是与 opencode **相反**的那一条：Pi 是 AgentMux 通过 PTY 起的进程，扩展在它里面读得到
      // `client.ts:2123-2124` 注入的变量。写进磁盘的 token 会长期留在用户 home 下，且 Binding 轮换后
      // 立刻失效——既泄密又过期。
      expect(mutation.content).toContain('process.env.AGENTMUX_HOOK_URL')
      expect(mutation.content).toContain('process.env.AGENTMUX_HOOK_TOKEN')
      // 反向：内容里不能出现任何形似真实 token 的内联字面量。这条在有人改成
      // `createPiManagedHookPlan(url, token)` 并内联时会红。
      expect(mutation.content).not.toMatch(/authorization['"]?\s*:\s*['"]Bearer [^'"+\s]/)
    })

    it('transcript 真存在才上报 session_file', () => {
      // 只是个文本存在性检查，防止有人把这段整个删掉。真正质询它行为的是下面
      // 「把生成的扩展真的跑起来」那一组——单靠 toContain 挡不住把 existsSync 的结果改成恒真。
      expect(mutation.content).toContain('existsSync')
      expect(mutation.content).toContain('session_file')
    })

    it('投递不 await，且整体 catch', () => {
      // Pi 会 await 每个 handler，投递挂在事件回路上会让用户的会话等我们的网络；一次网络失败
      // 更不能把会话打断。
      expect(mutation.content).toContain('void fetch(')
      expect(mutation.content).toContain('.catch(')
    })

    it('文件权限是 0600', () => {
      expect(mutation.mode).toBe(0o600)
    })

    it('不带 merge——这份文件 AgentMux 独占', () => {
      // 上游按目录扫每个 .ts/.js，用户自己的扩展是同目录下的别的文件，两边互不相干。
      expect(mutation.merge).toBeUndefined()
    })
  })

  /**
   * 把生成的扩展**真的跑起来**，而不是 grep 它的源码文本。
   *
   * 上面那组 `toContain` 断言有个共同的失明点：它们不执行代码。实测过——把 `existsSync` 那道门改成
   * 恒真（`let exists = true`，删掉整个 try/catch），26 条断言**一条都不红**，因为 `existsSync`
   * 这个词仍然出现在源码里、`session_file` 也仍然出现。文本在，逻辑没了。
   *
   * 所以这一组用 data URI 动态 import 把生成的模块加载成真模块，喂一个假的 `pi` 收集注册，再触发
   * handler、拦截 `fetch`，断言**投出去的负载**。这是唯一能质询控制流的方式。
   */
  describe('把生成的扩展真的跑起来——文本断言看不见控制流', () => {
    type Captured = { url: string; init: { headers: Record<string, string>; body: string } }

    /**
     * 加载生成的扩展，返回它注册的 handler 表与一个投递收集器。
     *
     * `sessionFile` 是喂给扩展的 transcript 路径。**这里刻意不替身 fs**：传一个真实存在或真实不存在
     * 的路径，让扩展用它自己解析到的 `node:fs` 去判断。
     *
     * 这一点是本组的关键，且是踩过的坑。此前这里注入 `globalThis.require` 当假 fs，结果掩盖了一个真
     * 缺陷：扩展当时写的是 `require('node:fs')`，而 jiti 在非二进制分发下可能原生 ESM 加载它
     * （`loader.ts:498-510` 没强制 `tryNative: false`），那里 `require` 根本不存在——ReferenceError
     * 被 `sessionFields` 的 catch 吞掉，`session_file` 永不上报，叠加 `requireTranscriptPath: true`
     * 就是 resume 永久失效，且毫无报错。假的 require 让这条测试替一个在真实加载器下必然坏掉的实现
     * 背了书。用真文件就没有这个盲点：模块怎么拿到 fs 是它自己的事，我们只问结果。
     */
    async function loadExtension(options: {
      env: Record<string, string | undefined>
      sessionFile: string
    }): Promise<{
      handlers: Map<string, (event: unknown, ctx: unknown) => void>
      posts: Captured[]
      flush: () => Promise<void>
    }> {
      const source = createPiManagedHookPlan({ PI_CODING_AGENT_DIR: '/tmp/pi-run' }).mutations[0]!.content
      const module = await import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
      )
      const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
      const posts: Captured[] = []
      const pending: Array<Promise<unknown>> = []

      const originalFetch = globalThis.fetch
      const originalEnv = { ...process.env }
      const originalCrypto = globalThis.crypto

      for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (!globalThis.crypto?.randomUUID) {
        Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'uuid-stub' }, configurable: true })
      }
      globalThis.fetch = ((url: string, init: Captured['init']) => {
        posts.push({ url, init })
        const settled = Promise.resolve({ ok: true } as Response)
        pending.push(settled)
        return settled
      }) as typeof fetch

      module.default({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler) } })

      return {
        handlers,
        posts,
        flush: async () => {
          await Promise.all(pending)
          globalThis.fetch = originalFetch
          process.env = originalEnv
          Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true })
        }
      }
    }

    // 真实的两条路径：一个确实落了盘，一个确保不存在。扩展用自己解析到的 fs 去判，我们不插手。
    const runDir = mkdtempSync(join(tmpdir(), 'agentmux-pi-ext-'))
    const presentTranscript = join(runDir, 'transcript.jsonl')
    writeFileSync(presentTranscript, '{"role":"assistant"}\n')
    const absentTranscript = join(runDir, 'not-written-yet.jsonl')
    afterAll(() => { rmSync(runDir, { recursive: true, force: true }) })

    const ctxFor = (sessionFile: string) => ({
      sessionManager: {
        getSessionId: () => 'pi-run-session',
        getSessionFile: () => sessionFile
      }
    })
    const sessionCtx = ctxFor(presentTranscript)

    const hookEnv = {
      AGENTMUX_HOOK_URL: 'http://127.0.0.1:7777/v1/events',
      AGENTMUX_HOOK_TOKEN: 'tok-pi-runtime'
    }

    it('transcript 不存在时投出去的负载里绝没有 session_file', async () => {
      // 这是「resume 会不会指向一个不存在的文件」那条。把 existsSync 的结果改成恒真，这条立刻红——
      // 而纯文本断言对同一处变异完全失明（实测存活）。
      const ext = await loadExtension({ env: hookEnv, sessionFile: absentTranscript })
      ext.handlers.get('agent_start')!({}, ctxFor(absentTranscript))
      await ext.flush()

      expect(ext.posts).toHaveLength(1)
      const payload = JSON.parse(ext.posts[0]!.init.body).payload
      expect(payload.session_id).toBe('pi-run-session')
      expect(payload).not.toHaveProperty('session_file')
    })

    it('transcript 存在时才带上 session_file', async () => {
      // 反向的一半。只有上一条时，一个「永远不报 session_file」的实现也能过——那会让 resume 永远
      // 不可用，且 requireTranscriptPath 会把每个 handle 都丢掉。
      const ext = await loadExtension({ env: hookEnv, sessionFile: presentTranscript })
      ext.handlers.get('agent_start')!({}, sessionCtx)
      await ext.flush()

      const payload = JSON.parse(ext.posts[0]!.init.body).payload
      expect(payload.session_file).toBe(presentTranscript)
    })

    it('注册的正好是声明的那七个事件，agent_end 不在其中', async () => {
      const ext = await loadExtension({ env: hookEnv, sessionFile: presentTranscript })
      await ext.flush()
      expect([...ext.handlers.keys()].sort()).toEqual([...PI_HOOK_EVENTS].sort())
      expect(ext.handlers.has('agent_end')).toBe(false)
    })

    it('endpoint 与 token 取自环境变量，且拼进 Bearer 头', async () => {
      const ext = await loadExtension({ env: hookEnv, sessionFile: presentTranscript })
      ext.handlers.get('agent_settled')!({}, sessionCtx)
      await ext.flush()

      expect(ext.posts[0]!.url).toBe('http://127.0.0.1:7777/v1/events')
      expect(ext.posts[0]!.init.headers.authorization).toBe('Bearer tok-pi-runtime')
      const body = JSON.parse(ext.posts[0]!.init.body)
      expect(body.eventName).toBe('agent_settled')
      expect(body.payload.hook_event_name).toBe('agent_settled')
    })

    it('环境变量缺席时一条都不投——不往一个空 URL 上打', async () => {
      // 修复路径或非 AgentMux 启动的 pi 会落在这里：扩展装着，但这个进程不是我们起的。
      const ext = await loadExtension({
        env: { AGENTMUX_HOOK_URL: undefined, AGENTMUX_HOOK_TOKEN: undefined },
        sessionFile: presentTranscript
      })
      ext.handlers.get('agent_start')!({}, sessionCtx)
      await ext.flush()
      expect(ext.posts).toEqual([])
    })

    it.each([
      ['只有 URL、没有 token', { AGENTMUX_HOOK_URL: 'http://127.0.0.1:7777/v1/events', AGENTMUX_HOOK_TOKEN: undefined }],
      ['只有 token、没有 URL', { AGENTMUX_HOOK_URL: undefined, AGENTMUX_HOOK_TOKEN: 'tok-only' }]
    ])('两个变量缺任意一个都不投：%s', async (_label, env) => {
      // 上一条只覆盖「两个都缺」，于是守卫写成 `if (!url) return`（漏掉 token 那一侧）也能过——
      // 实测存活。而那一侧正是最坏的：URL 在、token 空，于是每个事件都带着 `Bearer undefined`
      // 打到真实端点上，服务端拒绝、界面无状态，看起来像"装了但不工作"。逐个变量守。
      const ext = await loadExtension({ env, sessionFile: presentTranscript })
      ext.handlers.get('agent_start')!({}, sessionCtx)
      await ext.flush()
      expect(ext.posts).toEqual([])
    })

    it('两个工具事件的参数字段名不同，但都投成 tool_input', async () => {
      // 上游 `tool_call` 的参数在 `input`（types.ts:889-896），`tool_execution_start` 的在 `args`
      // （:798-803）。两处都写 `event.input` 或都写 `event.args` 会让其中一个静默丢参数——
      // 而两个事件的**工具名**字段恰好同名（toolName），所以只看工具名的断言抓不到这个错。
      const ext = await loadExtension({ env: hookEnv, sessionFile: presentTranscript })
      ext.handlers.get('tool_call')!({ toolName: 'bash', input: { command: 'ls' } }, sessionCtx)
      ext.handlers.get('tool_execution_start')!({ toolName: 'read', args: { path: '/tmp/x' } }, sessionCtx)
      await ext.flush()

      const first = JSON.parse(ext.posts[0]!.init.body).payload
      expect(first).toMatchObject({ tool_name: 'bash', tool_input: { command: 'ls' } })
      const second = JSON.parse(ext.posts[1]!.init.body).payload
      expect(second).toMatchObject({ tool_name: 'read', tool_input: { path: '/tmp/x' } })
    })

    it('sessionManager 缺席时不抛，只是不带 session 字段', async () => {
      // ctx 的形状是上游给的，我们只读不控。读崩了会把异常抛回 Pi 的事件回路。
      const ext = await loadExtension({ env: hookEnv, sessionFile: presentTranscript })
      expect(() => ext.handlers.get('agent_start')!({}, {})).not.toThrow()
      await ext.flush()
      const payload = JSON.parse(ext.posts[0]!.init.body).payload
      expect(payload).not.toHaveProperty('session_id')
    })
  })

  describe('接到 registry 的 managed 安装路径上', () => {
    it('resolveManagedHookPlan 按 id 找得到它，且不需要 endpoint', () => {
      // 与 opencode 相反：那家没有 endpoint 就必须弃权（返回 null），Pi 在修复路径（没有 Binding）
      // 也照常产出一份完全有效的 plan——因为内容在运行时才取 endpoint。
      const resolved = resolveManagedHookPlan('pi', '/tmp/ws', { PI_CODING_AGENT_DIR: '/tmp/pi-agent-dir' })
      expect(resolved?.providerId).toBe('pi')
      expect(resolved?.mutations[0]!.path).toBe('/tmp/pi-agent-dir/extensions/agentmux.js')
    })

    it('catalog 声明 explicit-managed——不再是 unmanaged', () => {
      // 此前记 unmanaged（"hook 是真的但我们不装"）。现在真的装了，声明必须跟上：conformance 守卫
      // 会按这个字段要求它产得出 plan。
      expect(pi.catalog.hookStrategy).toEqual({ kind: 'native', installation: 'explicit-managed' })
    })
  })
})
