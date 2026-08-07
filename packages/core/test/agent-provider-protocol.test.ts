import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import * as hookEventModule from '../src/agent-hook-event.js'
import type { AgentHookLifecycleDialect } from '../src/agent-hook-event.js'
import {
  AGENT_HOOK_LIFECYCLE_DIALECT,
  HOOK_EVENT_NAME_PAYLOAD_KEYS,
  canonicalHookLifecycleEvent,
  eventNamesCanReopenTurn,
  rawEventNamesForLifecycle,
  resolveHookEventName
} from '../src/agent-hook-event.js'
import { hookEventUpdatesSemanticStatus } from '../src/hook-turn-phase.js'
import { AgentMuxError } from '../src/errors.js'
import { ANTIGRAVITY_HOOK_EVENTS } from '../src/providers/antigravity.js'
import { CLAUDE_HOOK_EVENTS } from '../src/providers/claude.js'
import { CODEX_HOOK_EVENTS } from '../src/providers/codex.js'
import { COPILOT_HOOK_EVENTS } from '../src/providers/copilot.js'
import { CURSOR_HOOK_EVENTS } from '../src/providers/cursor.js'
import { DROID_HOOK_EVENTS } from '../src/providers/droid.js'
import { GEMINI_HOOK_EVENTS } from '../src/providers/gemini.js'
import { GROK_HOOK_EVENTS } from '../src/providers/grok.js'
import { HERMES_HOOK_EVENTS } from '../src/providers/hermes.js'
import { OPENCODE_HOOK_EVENTS } from '../src/providers/opencode.js'
import { PI_HOOK_EVENTS } from '../src/providers/pi.js'
import { USAGE_FINALIZATION_EVENTS } from '../src/agent-hook-command.js'
import type { AgentHookLifecycleEvent, AgentCatalogEntry } from '../src/types.js'

/**
 * T-002 的合同测试。分三组，各守验收里一条不同的东西：
 *
 * 1. **七条能力轴**：每个 Provider 的公共合同都同时诚实表达 capability / evidence / Hook /
 *    permission / resume / prompt delivery / reply-correlation，且整份合同可序列化——新 Provider
 *    只填这份声明，Desktop 与 ctxmux 都不必长出分支。
 * 2. **事件名归一化**：三个拼法（hook_event_name / hookEventName / eventName）都到得了同一个
 *    canonical 事件；snake_case 生命周期名按显式映射表归一化。
 * 3. **未知事件可诊断**：归一化不了的事件绝不伪造 working/done，且原始名必须留在诊断里。
 *
 * 归一化的**行为**后果（工具结果能否进时间轴）由 hook-normalizer.test.ts 守；这里守的是协议本身。
 */

/**
 * `agent-hook-event.ts` 里每一个导出的方言块，**从模块导出派生**——不手抄常量名。
 *
 * 为什么必须派生：判据的期望值一旦是被守清单的另一份手抄，就抓不到「新添的那一份」。
 * 手抄版只能发现不对称编辑；一个既没进私有 `HOOK_LIFECYCLE_DIALECTS`、也没进测试清单的
 * 新方言块（对称遗漏）会让 `toEqual` 恒真（实测 26 条全绿）。
 *
 * 按命名约定 `*_HOOK_DIALECT` 取，取值必须是普通对象——`AgentHookLifecycleDialect` 是
 * `Record<string, AgentHookLifecycleEvent>`，运行期没有品牌可查，所以约定就是判据。
 * 「这个约定与源文件里的 export 声明逐字相等」由本文件的自检用真源码文本另钉一次，
 * 那条自检不用 `toBeGreaterThan` 地板而是整份数组相等，故解析退化会红而不是静默变抽样。
 *
 * 谓词的目标类型写模块**自己导出的** `AgentHookLifecycleDialect`，不写 `Record<string, unknown>`：
 * 后者不在命名空间取值的 union 里（那个 union 还含 `HOOK_EVENT_NAME_PAYLOAD_KEYS` 的 readonly
 * 元组与四个函数类型），于是 TS2677「谓词类型必须可赋给形参类型」当场报错——我第一版就是这么写的，
 * core 的 tsconfig 含 `test/**` 所以它真的被执行、真的红了。写成模块自己的类型既过编译，也让下游
 * `Object.entries(dialect)` 拿到 `AgentHookLifecycleEvent` 而不是 `unknown`。
 *
 * 盲点（明说）：直接把 object literal 内联进 `HOOK_LIFECYCLE_DIALECTS`、不给它任何 `export const`
 * 名字的写法，这里看不见——它进了合并面却不在导出面，两条判据都不会红。今天七个块全是命名导出，
 * 且文件头写明「每个 Provider 一块声明、这里一行 spread」，内联写法违反那条约定；真要堵这个口，
 * 判据得升级成解析 `HOOK_LIFECYCLE_DIALECTS` 数组的每个元素必须是标识符引用。
 */
function declaredDialectExports(): { name: string; dialect: AgentHookLifecycleDialect }[] {
  return Object.entries(hookEventModule)
    .filter(
      (entry): entry is [string, AgentHookLifecycleDialect] =>
        entry[0].endsWith('_HOOK_DIALECT') &&
        typeof entry[1] === 'object' &&
        entry[1] !== null
    )
    .map(([name, dialect]) => ({ name, dialect }))
}

/**
 * 一个方言块里**没接进合并面**的条目（原始名缺席，或映射到了别的 canonical 事件）。
 *
 * 抽成函数是承重的，不是整洁：接线判据与它的反向自证必须走**同一个**谓词，否则自证证的是另一段
 * 逻辑。我第一版把自证里的过滤条件手抄了一遍，注释却写「走同一个判据函数」——那正是本仓
 * comment-promises-more-than-assertion 那一族（注释承诺的比断言强）。现在两个调用点共用这里。
 */
function unwiredEntries(dialect: AgentHookLifecycleDialect): [string, AgentHookLifecycleEvent][] {
  return Object.entries(dialect).filter(
    ([raw, canonical]) => AGENT_HOOK_LIFECYCLE_DIALECT[raw] !== canonical
  )
}

describe('Core Provider protocol', () => {
  const registry = new AgentProviderRegistry()
  const providers = registry.list()

  describe('七条能力轴在公共合同上齐备且诚实', () => {
    it('每个 Provider 都声明全部七条轴，没有一条靠代码里的隐式知识', () => {
      expect(providers.length).toBeGreaterThan(0)
      for (const provider of providers) {
        const catalog = provider.catalog
        // 1. capability：逐项声明。
        expect(catalog.capabilities.terminal).toBe(true)
        // 2. evidence：凭什么算就绪，指名观察者。
        expect(catalog.readySignal).toEqual({
          kind: 'foreground-process',
          expectedProcess: catalog.expectedProcess
        })
        // 3. Hook：有无，以及配置由谁安装。
        expect(['none', 'native']).toContain(catalog.hookStrategy.kind)
        // 4. permission：观察还是应答。
        expect(['none', 'observe', 'respond']).toContain(catalog.capabilities.permission)
        // 5. resume：有无 + 定位器种类。
        expect(['none', 'provider-native']).toContain(catalog.resumeStrategy.kind)
        // 6. prompt delivery：首个 Prompt 如何随启动送达，或明说**送不到**（`post-launch-only`）。
        expect(['positional-argv', 'hermes-query', 'flag-prompt-interactive', 'post-launch-only'])
          .toContain(catalog.promptDelivery)
        // 7. reply-correlation：能不能关联回 turn，凭什么关联。
        expect(['none', 'native-turn-id', 'acp-turn-id']).toContain(catalog.capabilities.replyCorrelation)
      }
    })

    it('声明与实际能力对齐：resume 定位器、permission 档位、hook 事件都不许空口宣称', () => {
      for (const provider of providers) {
        const { capabilities, hookStrategy, resumeStrategy } = provider.catalog

        // resume：声明 provider-native 就必须真能构出 argv；声明 none 就必须 fail closed。
        expect(capabilities.providerResume).toBe(resumeStrategy.kind === 'provider-native')
        if (resumeStrategy.kind === 'provider-native') {
          expect(['session-id', 'transcript-path']).toContain(resumeStrategy.locator)
        }

        // hook：没有 hook 的 Provider 不许声明 timeline/permission 能力——没有事件通路就没有证据来源。
        // hook 的有无由 `hookStrategy.kind` 单独承载（此前另有一份 `capabilities.hookEvents` 布尔镜像它，
        // 无人读、已删）。
        if (hookStrategy.kind === 'none') {
          expect(capabilities.timeline).toBe('unavailable')
          expect(capabilities.permission).toBe('none')
        }

        // permission: 'respond' 意味着能真的把答案送回去——必须有 interaction 协议兜底。
        // 用一个不存在的 optionId 探测：合法的失败是「找不到这个选项」，而不是「不支持交互」。
        if (capabilities.permission === 'respond') {
          expect(() => provider.planInteractionResponse(
            { kind: 'permission', id: 'probe', agentSessionId: 'probe', title: 'probe', options: [], evidence: { source: 'native-hook', observedAt: 1 } },
            { kind: 'permission', requestId: 'probe', decision: { outcome: 'selected', optionId: 'nope' } }
          )).not.toThrow(/does not support semantic terminal interactions/)
        }

        // usage 是可选轴，但一旦声明就必须是已知的 transcript 格式，不许是个含义未定的真值。
        if (capabilities.usage) {
          expect(capabilities.usage.kind).toBe('native-transcript')
          expect(['claude-jsonl', 'codex-rollout']).toContain(capabilities.usage.transcriptFormat)
        }
      }
    })

    it('整份合同是纯可序列化数据——没有函数或类实例能跨 IPC 丢失', () => {
      for (const entry of registry.catalog()) {
        // JSON 往返后逐字相等：任何函数/undefined/类实例都会在这一步现形。
        expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
        // argv 与键位这类 Provider 私有知识绝不出现在合同里，它们留在 Core 侧。
        const serialized = JSON.stringify(entry)
        expect(serialized).not.toContain('\\u001b')
        for (const value of Object.values(entry as unknown as Record<string, unknown>)) {
          expect(typeof value).not.toBe('function')
        }
      }
    })

    it('capability 轴的取值域由类型收口，registry 投影不丢字段', () => {
      // registry.catalog() 是跨 IPC 的那份投影：它必须带齐每个 Provider 声明的所有轴。
      const projected = registry.catalog()
      expect(projected).toHaveLength(providers.length)
      for (const provider of providers) {
        const entry = projected.find((candidate) => candidate.id === provider.id)
        expect(entry).toBeDefined()
        const axes: Array<keyof AgentCatalogEntry> = [
          'id', 'label', 'executable', 'expectedProcess', 'promptDelivery',
          'readySignal', 'hookStrategy', 'resumeStrategy', 'acpStrategy',
          'capabilities', 'launchOptions'
        ]
        for (const axis of axes) expect(entry).toHaveProperty(axis)
      }
    })
  })

  describe('Hook 事件名归一化', () => {
    it('三个拼法都到得了同一个 canonical 事件——没有一个拼法是二等公民', () => {
      // 这是本 task 的核心诉求之一：hookEventName / eventName / hook_event_name 同权。
      for (const key of HOOK_EVENT_NAME_PAYLOAD_KEYS) {
        expect(resolveHookEventName(undefined, { [key]: 'PostToolUse' })).toBe('PostToolUse')
        expect(canonicalHookLifecycleEvent(resolveHookEventName(undefined, { [key]: 'PostToolUse' })))
          .toBe('tool-use-end')
      }
      // 全部三个键都必须在清单里，缺一个就是回到「各读取点各认两个」的旧状态。
      expect([...HOOK_EVENT_NAME_PAYLOAD_KEYS].sort())
        .toEqual(['eventName', 'hookEventName', 'hook_event_name'])
    })

    it('信封上的显式事件名优先于负载——投递方明说的最权威', () => {
      expect(resolveHookEventName('Stop', { hook_event_name: 'PreToolUse' })).toBe('Stop')
      // 空白/非字符串的显式值不算「说了」，退回负载而不是让事件名变成空串。
      expect(resolveHookEventName('   ', { hook_event_name: 'PreToolUse' })).toBe('PreToolUse')
      expect(resolveHookEventName(undefined, {})).toBeUndefined()
      expect(resolveHookEventName(42, { hook_event_name: 'Stop' })).toBe('Stop')
    })

    it('snake_case 生命周期名按显式映射表归一化，不靠前缀形状去猜', () => {
      // Hermes 的方言。
      expect(canonicalHookLifecycleEvent('on_session_start')).toBe('session-start')
      expect(canonicalHookLifecycleEvent('pre_tool_call')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('post_tool_call')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('post_llm_call')).toBe('turn-end')
      expect(canonicalHookLifecycleEvent('on_session_end')).toBe('turn-end')
      // Pi 的方言。
      expect(canonicalHookLifecycleEvent('tool_execution_start')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('tool_execution_end')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('agent_settled')).toBe('turn-end')
      // `agent_end` **刻意不在表上**：Pi 在它之后还有 retry/compaction/queued 三条续跑路径，
      // 认它作收尾会在每次续跑前先报一次假完成（依据见 providers/pi.ts）。这一条与下面那条
      // 「不按前缀猜」同族——都是在钉「看起来像收尾的名字不等于收尾」。
      expect(canonicalHookLifecycleEvent('agent_end')).toBeUndefined()
      // PascalCase 的方言照旧成立。
      expect(canonicalHookLifecycleEvent('PreToolUse')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('PostToolUse')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('Stop')).toBe('turn-end')
    })

    it('不按前缀猜：PostInvocation 不是工具结果，尽管它以 Post 开头', () => {
      // 这一条正是被取代的 `startsWith('Post')` 会答错的地方——Antigravity 的 PostInvocation 是
      // 一次调用的外层收尾，不是一次工具调用的结果。形状推理会把它误判成带结果的事件。
      expect(canonicalHookLifecycleEvent('PostInvocation')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('PreInvocation')).toBeUndefined()
    })

    it('turn 收尾集合由映射表派生，覆盖每一家的收尾方言而不是只有 PascalCase 两条', () => {
      // USAGE_FINALIZATION_EVENTS 此前硬编码 ['Stop','StopFailure']：Hermes 与 Pi 的收尾读不到用量。
      for (const raw of ['Stop', 'StopFailure', 'post_llm_call', 'on_session_end', 'agent_settled']) {
        expect(USAGE_FINALIZATION_EVENTS.has(raw)).toBe(true)
        expect(canonicalHookLifecycleEvent(raw)).toBe('turn-end')
      }
      // 非收尾事件绝不在集合里——否则 mid-turn 事件会去读 transcript、还会误清上一 turn 的用量。
      // `agent_end` 在这一侧：它在 Pi 里之后还有三条续跑路径，此刻 transcript 尚未落定，
      // 拿它去读用量既读不全、又会把上一 turn 的数抹掉（依据见 providers/pi.ts）。
      for (const raw of ['PreToolUse', 'PostToolUse', 'pre_tool_call', 'post_tool_call', 'SessionStart', 'agent_end']) {
        expect(USAGE_FINALIZATION_EVENTS.has(raw)).toBe(false)
      }
      // 集合与映射表是同一份真相的两种形状，不许 drift。
      expect([...USAGE_FINALIZATION_EVENTS].sort()).toEqual([...rawEventNamesForLifecycle('turn-end')].sort())
    })

    it('映射表的每个值都是词汇表成员，反查是它的忠实逆运算', () => {
      const vocabulary: readonly AgentHookLifecycleEvent[] = [
        'session-start', 'user-prompt-submit', 'permission-request',
        'tool-use-start', 'tool-use-end', 'subagent-start', 'subagent-stop',
        'turn-start', 'turn-end'
      ]
      for (const canonical of Object.values(AGENT_HOOK_LIFECYCLE_DIALECT)) {
        expect(vocabulary).toContain(canonical)
      }
      for (const canonical of vocabulary) {
        const raws = rawEventNamesForLifecycle(canonical)
        expect(raws.length).toBeGreaterThan(0)
        for (const raw of raws) expect(canonicalHookLifecycleEvent(raw)).toBe(canonical)
      }
    })

    it('能收尾的 Provider 必须也能重开一个 turn——否则闸门永久 latch', () => {
      // 事故形状（实测）：Hermes 的 `post_llm_call` 收尾之后，此后每条 `pre_tool_call`/`post_tool_call`
      // 都被 turn-phase 闸门判「不更新语义状态」，整个 run 余下的 working / 等你态全部被静默吞掉。根因
      // 不是少一个映射，而是闸门的前提（收尾后要再动工必先开新一轮）在这家 Provider 上不成立。
      //
      // 判据取 Provider **自己 rules 里声明的原始事件名**，不是方言表的键。这一点是判据的成败所在：
      // 方言表可以被塞进一个 Provider 从不触发的键而让不变量假绿（审查实测过这个绕法），而 rules 是
      // 这家 Provider 真的装了、也真的会据以判状态的那批名字，与 client.ts 喂给闸门的是同一个来源。
      //
      // Pi 刻意留红——它登记在下面的缺口清单里，且这条登记与「闸门对无重开能力的 Provider 不 latch」
      // 那条守卫**成对**存在。给 Pi 编一个重开映射会让这条红变绿，但那是声明一个无第一方证据的能力
      // （本仓北极星禁止，见 pi-unverified-declaration.test.ts），所以正确做法是保持缺口显式。
      const KNOWN_NO_REOPENER: readonly string[] = ['pi']

      const finalizers: string[] = []
      const reopeners: string[] = []
      for (const provider of providers) {
        const declared = provider.hook.rules.flatMap((rule) => rule.events)
        const canFinalize = declared.some((raw) => canonicalHookLifecycleEvent(raw) === 'turn-end')
        const canReopen = eventNamesCanReopenTurn(declared)
        if (canFinalize) finalizers.push(provider.id)
        if (canReopen) reopeners.push(provider.id)

        if (!canFinalize) continue
        expect(
          canReopen,
          `${provider.id} 能收尾却无法重开：闸门会在它第一次收尾后永久吞掉状态。` +
          '要么给它一个有第一方证据的重开事件，要么把它登记进 KNOWN_NO_REOPENER 并保留成对的守卫。'
        ).toBe(!KNOWN_NO_REOPENER.includes(provider.id))
      }

      // 自检三条，缺一条这条不变量就可能在退化的输入上恒真。
      expect(finalizers.length, '判据失效：没有任何 Provider 能收尾').toBeGreaterThan(0)
      expect(reopeners.length, '判据失效：没有任何 Provider 能重开').toBeGreaterThan(0)
      // 缺口清单不许烂掉：登记的名字必须真的是一个在册 Provider，且真的还缺重开能力。
      for (const id of KNOWN_NO_REOPENER) {
        const provider = providers.find((candidate) => candidate.id === id)
        expect(provider, `缺口清单里的 ${id} 不是在册 Provider——清单过期了`).toBeDefined()
        expect(
          reopeners,
          `${id} 已经有重开能力了：把它从 KNOWN_NO_REOPENER 删掉，别留一个假缺口`
        ).not.toContain(id)
      }
    })

    it('rules 说 done 的那些原始名，方言表必须也说 turn-end——两处对同一步各判一次', () => {
      // 上面那条「能收尾必须能重开」的判据里有 `if (!canFinalize) continue`，而 canFinalize 是**按方言
      // 归一后**算的。于是一家 Provider 的 rules 里明写着 `state: 'done'`、方言表里却没有对应的
      // `turn-end` 时，它算出 canFinalize=false，被 continue 整条跳过——不变量对它完全失明，恰恰是
      // 最该问的那一家（本仓「判别器可能在别的环境缺席」与「守卫按出口数不按条件数」两族的交集）。
      //
      // 实测的分岔：13 家里 12 家 divergent=[]，只有 opencode 的 `session.status`/`session.idle`
      // 两个 done 事件在方言表里认不出（它整份 rules 七个原始名全部归一失败）。这不是缺陷而是**刻意**：
      // 那七个名字是 dot.case 的上游事件类型，与「一个原始名在每家 Provider 上都表示同一结构步骤」
      // 这条合并表的前提不冲突，但也没有任何第一方证据说它们该被当成 canonical 生命周期步骤——
      // 声明未核实的能力是本仓北极星禁止的。代价是可算的、且今天方向安全：
      //   * turn-phase 闸门永不 latch（`hookTurnPhaseAfter(undefined)` 恒 undefined），
      //     所以 opencode 拿不到「收尾后压制迟到工具事件」这层保护，但也永不误伤——与 Pi 那条缺口同族；
      //   * USAGE_FINALIZATION_EVENTS 不含它的收尾名，而 opencode **本来就不声明 usage 能力**
      //     （无单文件 transcript），所以这一侧无损失；
      //   * 时间轴的 `isToolResult` 恒 false，而它的 rules 里也确实没有任何工具事前/事后事件。
      // 语义状态照旧由 rules 直接给出，所以「done 显示不出来」不会发生。
      //
      // 判据因此分两半：有映射的那些必须与 rules 一致（漏一个映射即在此报红），而刻意无映射的那家
      // 必须显式登记并自带前提自检——不许把它默默留在 continue 后面。
      const KNOWN_UNMAPPED_DONE: readonly string[] = ['opencode']

      let comparedDoneEvents = 0
      for (const provider of providers) {
        const doneEvents = provider.hook.rules
          .filter((rule) => rule.state === 'done')
          .flatMap((rule) => rule.events)
        if (doneEvents.length === 0) continue
        const divergent = doneEvents.filter((raw) => canonicalHookLifecycleEvent(raw) !== 'turn-end')
        if (KNOWN_UNMAPPED_DONE.includes(provider.id)) {
          // 登记的那家：要求它**整批**都没映射。半边有半边没有才是真漂移——那说明有人补了一部分，
          // 于是 canFinalize 变 true 而另一半的收尾静默读不出来。
          expect(
            divergent.sort(),
            `${provider.id} 的 done 事件只有一部分没映射：这是漂移而不是刻意的缺口`
          ).toEqual([...doneEvents].sort())
          continue
        }
        expect(
          divergent,
          `${provider.id} 的 rules 说这些事件是 done，方言表却不认它们是 turn-end。` +
          '后果不是少一个映射：canFinalize 按方言算，于是「能收尾必须能重开」那条不变量会把它整条跳过。'
        ).toEqual([])
        comparedDoneEvents += doneEvents.length
      }

      // 自检：没有比对过任何有映射的收尾事件时，上面每一条都退化成 [] === []。
      expect(comparedDoneEvents, '判据失效：没有比对过任何已映射的 done 事件').toBeGreaterThan(10)
      // 登记清单不许烂掉：名字必须真的是在册 Provider，且它真的还有 done 规则要谈。
      for (const id of KNOWN_UNMAPPED_DONE) {
        const provider = providers.find((candidate) => candidate.id === id)
        expect(provider, `登记清单里的 ${id} 不是在册 Provider——清单过期了`).toBeDefined()
        const doneEvents = provider?.hook.rules.filter((rule) => rule.state === 'done') ?? []
        expect(doneEvents.length, `${id} 已经没有 done 规则了：把它从清单里删掉`).toBeGreaterThan(0)
      }
      // 缺口的代价前提之一：登记的那家不声明 usage 能力，所以「收尾读不到用量」在它身上不是损失。
      // 前提一旦不成立（有人给它加了 usage），这里先红，而不是等用户发现用量永远是「—」。
      for (const id of KNOWN_UNMAPPED_DONE) {
        const provider = providers.find((candidate) => candidate.id === id)
        expect(
          provider?.catalog.capabilities.usage,
          `${id} 现在声明了 usage 能力，但它的收尾事件不在 USAGE_FINALIZATION_EVENTS 里：用量永远读不到`
        ).toBeFalsy()
      }
    })

    it('无重开能力的 Provider 走不 latch 的兜底——与上面那份缺口清单成对', () => {
      // 这条是缺口清单的另一半。清单说「Pi 缺重开能力」，这条说「所以闸门对它不 latch」。
      // 谁删掉兜底，这条先红；谁悄悄给 Pi 编个映射，上一条先红。两条都在才算把缺口守住。
      expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-start', false)).toBe(true)
      // 正向对照：有重开能力时照旧抑制，否则把兜底写成「永远不抑制」也全绿。
      expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-start', true)).toBe(false)
    })

    it('装了重开事件的 Provider，rules 也必须认得出重开——闸门读的是 rules', () => {
      // 这一层堵的是「安装清单与 rules 各说一套」：安装清单（`*_HOOK_EVENTS`）决定**投递**什么，
      // rules 决定 Core 看到它时怎么判，而闸门的重开能力从 rules 算（client.ts 摄入侧就是这么喂的）。
      // 装了却没进 rules（antigravity 的 `UserPromptSubmit` 实测如此）＝闸门以为这家不能重开，
      // 白丢一层「收尾后压制迟到工具事件」的保护，而所有测试照旧全绿。
      //
      // **判据比的是 canonical 能力，不是原始名逐字相等**，这一点是对的而非图省事：grok 的两个面拼法
      // 本来就不同——配置侧写 PascalCase（`UserPromptSubmit`），投递侧报 snake_case
      // （`user_prompt_submit`），rules 匹配的是投递侧。按原始名比会把 grok 判成漏配（实测如此），
      // 那是判据自己错，不是 grok 有缺陷。比 canonical 则两个面的拼法差异被方言表吸收掉，
      // 真正的漏配（一个面能重开、另一个面认不出）仍然照抓。
      //
      // 只对 explicit-managed 强制：那批是 AgentMux 亲手写配置的，安装清单是我们自己的声明，能核对。
      // 无 hook 的（traex）没有安装面。**这里不再有「unmanaged 拿不到清单」那一档**：pi 曾经是
      // unmanaged，现在它与 opencode 一样由 AgentMux 写一份生成的扩展/插件文件，安装清单同样是我们
      // 自己声明的（`PI_HOOK_EVENTS`/`OPENCODE_HOOK_EVENTS` 就是生成代码里 `on()` 的那批名字），
      // 所以照样要核对。这条表漏一家的后果由紧跟的 toBeDefined 顶着——那正是本轮合并时它报出来的。
      const INSTALLED_HOOK_EVENTS: Readonly<Record<string, readonly string[]>> = {
        antigravity: ANTIGRAVITY_HOOK_EVENTS,
        claude: CLAUDE_HOOK_EVENTS,
        codex: CODEX_HOOK_EVENTS,
        copilot: COPILOT_HOOK_EVENTS,
        cursor: CURSOR_HOOK_EVENTS,
        droid: DROID_HOOK_EVENTS,
        gemini: GEMINI_HOOK_EVENTS,
        grok: GROK_HOOK_EVENTS,
        hermes: HERMES_HOOK_EVENTS,
        opencode: OPENCODE_HOOK_EVENTS,
        pi: PI_HOOK_EVENTS
      }

      let compared = 0
      let installedCanReopenCount = 0
      for (const provider of providers) {
        if (provider.catalog.hookStrategy.kind !== 'native') continue
        if (provider.catalog.hookStrategy.installation !== 'explicit-managed') continue
        const installed = INSTALLED_HOOK_EVENTS[provider.id]
        expect(
          installed,
          `${provider.id} 是 explicit-managed 却没登记安装清单——这张表漏了一家，那家的漏配从此免检`
        ).toBeDefined()
        if (!installed) continue
        compared += 1

        const installedCanReopen = eventNamesCanReopenTurn(installed)
        const rulesCanReopen = eventNamesCanReopenTurn(provider.hook.rules.flatMap((r) => r.events))
        if (installedCanReopen) installedCanReopenCount += 1
        expect(
          rulesCanReopen,
          `${provider.id} 的安装清单里有重开事件，rules 却认不出任何一个：闸门按 rules 算重开能力，` +
          '于是它以为这家不能重开，白丢一层「收尾后压制迟到工具事件」的保护。' +
          '（若两侧拼法不同，rules 要写投递侧那个拼法。）'
        ).toBe(installedCanReopen)
      }

      // 自检两条，缺一条这条就可能在退化的输入上恒真。
      expect(compared, '判据失效：没有比对过任何 Provider').toBeGreaterThan(5)
      expect(
        installedCanReopenCount,
        '判据失效：没有任何 Provider 的安装清单能重开，于是上面每一条都退化成 false===false'
      ).toBeGreaterThan(0)
    })

    it('方言按 Provider 分块声明，合并面等于各块之并——新 Provider 只动自己那块', () => {
      // 这是为并行开发做的结构约束：加一个 Provider 不该改任何已有 Provider 的映射。
      // 合并面必须恰好等于各块的并集，既不丢（漏接线）也不多（有人偷偷往全局表塞条目）。
      //
      // 块清单**从模块导出派生**（见 `declaredDialectExports`），不在这里手抄第二份。
      // 此前这里写死了七个常量名，于是判据只抓「不对称」编辑：改源文件那份数组而忘了改这里 → 红。
      // 但**对称遗漏**完全隐身——新写一个 `X_HOOK_DIALECT`，既没进 `HOOK_LIFECYCLE_DIALECTS`
      // 也没进这里的清单，两边都缺，`toEqual` 照旧成立。实测：注入一个孤儿 `ZULU_HOOK_DIALECT`
      // 后 26 条全绿（基线也是 26），而那家 Provider 的 hook 事件会全部落到「不认识的生命周期」、
      // 时间轴永不前进。期望值是被守清单的另一份手抄，就抓不到新添的那一份
      //（记忆 equivalence-cannot-catch-a-fresh-copy / expected-value-must-not-derive-from-mutation-target）。
      const blocks = declaredDialectExports().map(({ dialect }) => dialect)
      const union: Record<string, AgentHookLifecycleEvent> = {}
      for (const block of blocks) Object.assign(union, block)
      expect(AGENT_HOOK_LIFECYCLE_DIALECT).toEqual(union)

      // 每块自己都必须只用词汇表里的值，且块之间不许对同一个原始名给出不同的结构语义。
      for (const block of blocks) {
        for (const [raw, canonical] of Object.entries(block)) {
          expect(canonicalHookLifecycleEvent(raw)).toBe(canonical)
        }
      }
    })

    it('每个导出的方言块都真的接进了合并面——孤儿块（写了没接）必须红', () => {
      // 上面那条用派生清单算并集，于是「导出了但没接线」这件事在它那里不可观测：孤儿块进了 blocks，
      // 也就进了 union，两边一起多一份、仍然相等。所以真正的接线判据在这里：**逐块**问
      // 「你的每一个原始名在合并面里吗、且映射一致吗」。孤儿块的键不在 `AGENT_HOOK_LIFECYCLE_DIALECT`
      // 里（它由源文件那个私有数组 spread 出来），于是当场红。
      //
      // 反方向（进了私有数组却没 export）由 `declaredDialectExports` 的解析面兜住：那个数组只能引用
      // 本文件的绑定，没导出的绑定拿不到 → 上面那条的 union 会缺它 → toEqual 红。
      const exported = declaredDialectExports()
      for (const { name, dialect } of exported) {
        for (const [raw, canonical] of unwiredEntries(dialect)) {
          expect.fail(
            `${name} 声明了 ${raw}→${canonical}，但合并面里没有它（实际是 ${String(AGENT_HOOK_LIFECYCLE_DIALECT[raw])}）——这个块没接进 HOOK_LIFECYCLE_DIALECTS`
          )
        }
      }
      // 正面钉住这条用例真的看过东西：`exported` 为空时上面的循环一次都不进，判据会恒绿。
      expect(exported.length, '一个方言块都没解析到——判据退化成恒真').toBeGreaterThan(0)
    })

    it('自检：解析面确实数到了每一个导出的方言块（少一个就退化成抽样）', () => {
      // 若 `declaredDialectExports` 的解析退化（正则失配、import 求值拿到 undefined），上面两条会在
      // 空集或子集上恒绿。这条正面钉住：源文件里以 `export const *_HOOK_DIALECT` 声明的名字集合，
      // 必须与解析出来的名字集合**逐字相等**——不是「至少 N 个」这种地板。
      const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent-hook-event.ts'),
        'utf8'
      )
      const declaredInSource = [...source.matchAll(/^export const (\w+_HOOK_DIALECT)\b/gmu)]
        .map((match) => match[1]!)
        .sort()
      expect(declaredInSource.length, '源文件里一个 *_HOOK_DIALECT 导出都没扫到——解析面退化了').toBeGreaterThan(0)
      expect(
        declaredDialectExports().map(({ name }) => name).sort(),
        '解析出的方言块与源文件里的 export 声明不一致'
      ).toEqual(declaredInSource)
    })

    it('自检：注入一个孤儿方言块，接线判据必红（证明它不是恒真）', () => {
      // 这是上面「孤儿块必须红」那条的反向自证。不改源文件，只在**内存里**造一个没接线的块，
      // 喂给上面那条用的同一个 `unwiredEntries`。若那个谓词恒返回空，上面那条就永远抓不到孤儿块，
      // 而这里会红——这是它唯一的活性证明。
      const orphan: AgentHookLifecycleDialect = { zulu_session_open: 'session-start' }
      expect(
        unwiredEntries(orphan).map(([raw]) => raw),
        '孤儿块的键竟然被判成已接线——上面那条接线判据是恒真的'
      ).toEqual(['zulu_session_open'])
      // 反向：一个真接线过的块必须判成空，否则谓词恒红、上面那条会对健康代码打假红。
      const wired = declaredDialectExports()[0]!
      expect(
        unwiredEntries(wired.dialect),
        `${wired.name} 是真接线过的块，却被判成未接线——谓词恒红会对健康代码打假红`
      ).toEqual([])
    })

    it('不做大小写折叠：只有真被观察到的拼法在表里，折过来的拼法一律认不出', () => {
      // 归一化（把 PreToolUse 正则折成 pre_tool_use）会顺带接受从没被任何 Provider 观察到的串，
      // 于是表里的键不再等于「有证据的事实」。这条守住「能力未核实就不声明」那条北极星。
      //
      // `PreToolUse` 与 `pre_tool_use` **两个拼法都在表里**，但那不是折叠的结果：前者是
      // Claude 一族的真实 wire 值，后者是 grok 的真实 wire 值，各有各的证据、各在自己那块声明。
      expect(canonicalHookLifecycleEvent('PreToolUse')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('pre_tool_use')).toBe('tool-use-start')
      // 而这两个谁也没观察到过——折叠一旦引入，它们就会跟着被认出来。
      expect(canonicalHookLifecycleEvent('pretooluse')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('PRE_TOOL_USE')).toBeUndefined()
      // 最尖的一例：`StopCancelled` 是 grok **配置侧**的真实字符串（见 GROK_HOOK_EVENTS），
      // 但它永远不会出现在 wire 上——grok 报的是 `stop_cancelled`。折叠会把这个配置名也认成
      // 生命周期事件，于是「装进配置的名字」和「投递上来的名字」这两个面就被搅成了一个。
      expect(canonicalHookLifecycleEvent('stop_cancelled')).toBe('turn-end')
      expect(canonicalHookLifecycleEvent('StopCancelled')).toBeUndefined()
      // 同族反向：Hermes 的真实拼法在表里，它的 PascalCase 幻影不在。
      expect(canonicalHookLifecycleEvent('post_tool_call')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('PostToolCall')).toBeUndefined()
    })
  })

  describe('未知事件保持可诊断，绝不伪造语义', () => {
    it('归一化不了的事件：lifecycleEvent 缺席，原始名留在诊断里', () => {
      const event = registry.get('traex').normalizeHook({
        receiptId: 'r-unknown',
        agentSessionId: 's-unknown',
        runId: 'run-unknown',
        providerId: 'traex',
        eventName: 'quantum_flux_observed'
      })
      // 缺席，而不是被塞一个「差不多」的 canonical 值。
      expect(event.lifecycleEvent).toBeUndefined()
      // 绝不伪造 working/done。
      expect(event.semanticState).toBe('unknown')
      expect(event.status.state).toBe('running')
      // 原始名逐字可诊断——这是排查「Core 为什么没认出来」的唯一线索。
      expect(event.eventName).toBe('quantum_flux_observed')
      expect(event.status.detail).toBe('quantum_flux_observed')
    })

    it('事件名压根读不出来时如实记 unknown，而不是猜一个', () => {
      const event = registry.get('traex').normalizeHook({
        receiptId: 'r-nameless',
        agentSessionId: 's-nameless',
        runId: 'run-nameless',
        providerId: 'traex',
        payload: { some_unrelated_field: 'x' }
      })
      expect(event.eventName).toBe('unknown')
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
    })

    it('canonical 事件在场时，原始名依然逐字保留——两者并存不互相取代', () => {
      const event = registry.get('hermes').normalizeHook({
        receiptId: 'r-both',
        agentSessionId: 's-both',
        runId: 'run-both',
        providerId: 'hermes',
        eventName: 'post_tool_call',
        payload: { tool_name: 'shell' }
      })
      expect(event.lifecycleEvent).toBe('tool-use-end')
      // 原始名没有被 canonical 值顶掉。
      expect(event.eventName).toBe('post_tool_call')
      expect(event.status.detail).toBe('post_tool_call')
    })

    it('未知事件不产生 handle，也不产生用量——缺席一路传导到底', () => {
      const event = registry.get('claude').normalizeHook({
        receiptId: 'r-unknown-2',
        agentSessionId: 's-unknown-2',
        runId: 'run-unknown-2',
        providerId: 'claude',
        eventName: 'TotallyMadeUpEvent',
        payload: {}
      })
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.nativeHandle).toBeUndefined()
      expect(event.turnUsage).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
    })
  })

  describe('native handle 仍由 Provider 自己解释', () => {
    it('Provider 声明的键名决定 handle 从哪读——Core 不认识「哪个键装着会话 id」', () => {
      // Antigravity 声明 conversationId 优先；Core 没有任何地方硬编码这个键名。
      const antigravity = registry.get('antigravity').normalizeHook({
        receiptId: 'r-agy',
        agentSessionId: 's-agy',
        runId: 'run-agy',
        providerId: 'antigravity',
        eventName: 'SessionStart',
        payload: { conversationId: 'agy-conversation-1' }
      })
      expect(antigravity.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'antigravity',
        sessionId: 'agy-conversation-1'
      })

      // Pi 声明 session_file 作为 transcript 且要求它在场——同一个 Core 代码路径，不同 Provider 声明。
      const pi = registry.get('pi').normalizeHook({
        receiptId: 'r-pi',
        agentSessionId: 's-pi',
        runId: 'run-pi',
        providerId: 'pi',
        eventName: 'agent_start',
        payload: { session_id: 'pi-1', session_file: '/tmp/pi-protocol.jsonl' }
      })
      expect(pi.nativeHandle).toMatchObject({ sessionId: 'pi-1', transcriptPath: '/tmp/pi-protocol.jsonl' })
    })

    it('camelCase 与 snake_case 的 handle 键在同一个 Provider 上都读得出', () => {
      for (const key of ['session_id', 'sessionId'] as const) {
        const event = registry.get('antigravity').normalizeHook({
          receiptId: `r-${key}`,
          agentSessionId: `s-${key}`,
          runId: `run-${key}`,
          providerId: 'antigravity',
          eventName: 'SessionStart',
          payload: { [key]: `agy-${key}` }
        })
        expect(event.nativeHandle).toMatchObject({ sessionId: `agy-${key}` })
      }
      for (const key of ['transcript_path', 'transcriptPath'] as const) {
        const event = registry.get('claude').normalizeHook({
          receiptId: `r-${key}`,
          agentSessionId: `s-${key}`,
          runId: `run-${key}`,
          providerId: 'claude',
          eventName: 'SessionStart',
          payload: { session_id: 'claude-1', [key]: '/tmp/claude-protocol.jsonl' }
        })
        expect(event.nativeHandle).toMatchObject({ transcriptPath: '/tmp/claude-protocol.jsonl' })
      }
    })

    it('未声明 handle 的 Provider 永远不产生 handle，哪怕负载里躺着一个 session_id', () => {
      // Hermes 没有 nativeHandle 声明，也没有 native resume。Core 绝不替它「顺手」认一个 handle：
      // 那会让一个不支持 resume 的 Provider 看起来可以 resume。
      const event = registry.get('hermes').normalizeHook({
        receiptId: 'r-hermes-handle',
        agentSessionId: 's-hermes-handle',
        runId: 'run-hermes-handle',
        providerId: 'hermes',
        eventName: 'on_session_start',
        payload: { session_id: 'hermes-looks-resumable', transcript_path: '/tmp/hermes.jsonl' }
      })
      expect(event.nativeHandle).toBeUndefined()
      expect(registry.get('hermes').catalog.resumeStrategy.kind).toBe('none')
    })
  })

  describe('恢复被拒时说清卡在哪，且不泄露用户输入', () => {
    function refusal(run: () => unknown): AgentMuxError {
      try {
        run()
      } catch (error) {
        expect(error).toBeInstanceOf(AgentMuxError)
        return error as AgentMuxError
      }
      throw new Error('expected the resume to be refused')
    }

    it('「这个 Provider 不支持 resume」与「handle 属于别的 Provider」是可分辨的两种失败', () => {
      // 同一个错误码此前承载多种原因，界面只能笼统说一句恢复不了。detail 必须分开说清。
      const unsupported = refusal(() => registry.get('hermes').buildResumeLaunch({
        workspacePath: '/tmp/work',
        nativeHandle: { kind: 'provider', providerId: 'hermes', sessionId: 'h-1' },
        args: [], env: {}
      }))
      expect(unsupported.code).toBe('AGENT_RESUME_UNSUPPORTED')
      expect(unsupported.detail).toContain('providerId=hermes')
      expect(unsupported.detail).toContain('reason=provider-has-no-native-resume')
      // 声明与实现两侧都要报出来，好区分「CLI 本来不支持」与「Provider 模块漏了实现」。
      expect(unsupported.detail).toContain('declaresResume=false')

      // 支持 resume，但 handle 是别人的：该刷新会话，不是换 Provider。
      const mismatch = refusal(() => registry.get('claude').buildResumeLaunch({
        workspacePath: '/tmp/work',
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'c-1' },
        args: [], env: {}
      }))
      expect(mismatch.code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      expect(mismatch.detail).toContain('expectedProviderId=claude')
      expect(mismatch.detail).toContain('handleProviderId=codex')
      expect(mismatch.detail).toContain('reason=handle-provider-mismatch')
    })

    it('同一个错误码下「handle 不对」与「缺 transcript 路径」也分得开', () => {
      // Pi 的 resume locator 是 hook 报出的 session_file。Provider 对得上、只是那个字段还没到——
      // 与上一条的 handle-provider-mismatch 共用错误码，靠 detail 区分该等待还是该刷新。
      const missing = refusal(() => registry.get('pi').buildResumeLaunch({
        workspacePath: '/tmp/work',
        nativeHandle: { kind: 'provider', providerId: 'pi', sessionId: 'pi-1' },
        args: [], env: {}
      }))
      expect(missing.code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      expect(missing.detail).toContain('missingField=transcriptPath')
      expect(missing.detail).toContain('reason=hook-has-not-reported-session-file')
      // 关键：与 handle 归属错误的原因串不同，否则界面又只能笼统说一句。
      expect(missing.detail).not.toContain('handle-provider-mismatch')
    })

    it('细节里绝不出现 sessionId、transcript 路径或 prompt 正文——它会跨客户端边界', () => {
      const secretId = 'SECRET-SESSION-ID-42'
      const secretPath = '/private/SECRET-TRANSCRIPT.jsonl'
      const secretPrompt = 'SECRET-PROMPT-do-not-leak'

      const mismatch = refusal(() => registry.get('claude').buildResumeLaunch({
        workspacePath: '/tmp/work',
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: secretId, transcriptPath: secretPath },
        prompt: secretPrompt,
        args: [], env: {}
      }))
      for (const surface of [mismatch.detail ?? '', mismatch.message]) {
        expect(surface).not.toContain(secretId)
        expect(surface).not.toContain(secretPath)
        expect(surface).not.toContain(secretPrompt)
        expect(surface).not.toContain('SECRET')
      }

      const missing = refusal(() => registry.get('pi').buildResumeLaunch({
        workspacePath: '/tmp/work',
        nativeHandle: { kind: 'provider', providerId: 'pi', sessionId: secretId },
        prompt: secretPrompt,
        args: [], env: {}
      }))
      for (const surface of [missing.detail ?? '', missing.message]) {
        expect(surface).not.toContain(secretId)
        expect(surface).not.toContain(secretPrompt)
      }
    })
  })
})
