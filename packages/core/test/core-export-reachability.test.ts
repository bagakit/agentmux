import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collect,
  compositionEdges,
  deadExportsIn,
  identifierIndex,
  NON_EXPORTED_INTERMEDIARY_WITNESSES,
  parse,
  topLevelBindings,
  valueExportsOf
} from './helpers/export-reachability.js'

// ---------------------------------------------------------------------------
// 「packages/core/src 下**每一个**模块的值导出都还有生产调用方」的全包守卫。
//
// 判据引擎（不动点、导出抽取、标识符计数、它看不见什么）住在 test/helpers/export-reachability.ts，
// **那份文件头是判据的权威说明**，包括三条盲点。本文件只做三件事：把消费面定下来、维护豁免表、
// 守住这道门自己的自检。
//
// 为什么要有这道门（由来）：此前只有 test/control-export-reachability.test.ts 一个模块被这条判据
// 覆盖。`src/errors.ts` 的 `CommandExecutionError` 因此死了很久没人发现——它从来不在任何可达性判据的
// 覆盖面里。一条只覆盖一个模块的规则，抓到的是那一个模块，不是那一类问题。
//
// 与 control 那道门的分工：control.ts 有它自己的专门自检（种子/闭包分界 #580、`.mjs` 消费面在场
// #566），那些是那个模块特有的历史位点，留在原处；本门负责"每个模块都被问过一次"这件事。两者
// **共用同一个引擎**，不各抄一份——手抄一份引擎正是 errors.ts 从没被覆盖过的原因。
//
// 豁免表的形状（这是本门最容易腐烂的地方）：每条豁免都必须自带**可断言的前提**，而不是一句
// "刻意保留"。自检 3/4 会逐条质询：那个导出还在不在（表里的名字会随重命名变成虚构）、它是不是**仍然**
// 死着（接上消费者之后豁免就该删掉，否则表只增不减）、以及它声称的前提今天还成不成立
// （`barrel: true` 的必须真的在 src/index.ts 的 `export *` 面上）。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = join(here, '..') // packages/core
const repoRoot = join(coreRoot, '..', '..')
const barrelPath = join(coreRoot, 'src', 'index.ts')

/**
 * 消费者面：core 生产源码 + CLI 入口 + 打包消费契约夹具 + desktop 生产源码。
 *
 * 与 control 那道门同一个面（同一个判据，不该有两种"什么算消费者"）。**故意不含 `.test.ts`**：
 * 一个只被单元测试引用的导出正是"零生产调用方"，那是要被抓的东西，不是让判据变绿的理由。
 *
 * 减去被测模块自己这件事由 {@link deadExportsIn} 按索引键**结构性**完成，不是本函数的义务
 * （#580 那次假绿正是"调用方忘了减"的形状）。自检 2 钉住那个 skip 真的发生了。
 */
function consumerFiles(): string[] {
  return [
    ...collect(join(coreRoot, 'src'), ['.ts', '.tsx']),
    ...collect(join(coreRoot, 'bin'), ['.js', '.mjs', '.cjs']),
    ...collect(join(coreRoot, 'test', 'fixtures'), ['.mjs', '.cjs', '.js', '.ts']),
    ...collect(join(repoRoot, 'apps', 'desktop', 'src'), ['.ts', '.tsx'])
  ].filter((file) => !file.endsWith('.d.ts'))
}

function coreModules(): string[] {
  return collect(join(coreRoot, 'src'), ['.ts']).filter((file) => !file.endsWith('.d.ts'))
}

/**
 * 刻意保留的零生产调用方导出。
 *
 * `premise` 是这条豁免**为什么**成立的那句话；`barrel` 表示它的前提是"经 src/index.ts 的
 * `export *` 对外公开，删掉就是破坏公共 API"，自检 4 会去 index.ts 里核对那条 `export *` 真在场。
 * 没有 `barrel` 的条目，前提由 `premise` 自己承担，并且应当能在被豁免模块的注释里找到同一句话。
 */
const DELIBERATE: ReadonlyArray<{
  module: string
  name: string
  barrel?: true
  premise: string
}> = [
  {
    module: 'src/runtime-endpoint-reclaim.ts',
    name: 'socketIsDirectChildOfEndpoint',
    premise:
      '两道回收闸的正确性都取决于「socket 是 endpoint 目录的**直接**子项」，' +
      '模块注释把这件事明说成一个被测试质询的谓词（「挪走它会红，不再依赖谁记得回头看这里」）。' +
      '它的调用方是 test/runtime-endpoint-reclaim.ts——那正是这个导出存在的目的。'
  },
  {
    module: 'src/agent-ask.ts',
    name: 'openAsk',
    barrel: true,
    premise:
      '经 barrel 公开的 ask 生命周期入口。更大的事实：本仓**没有任何**生产代码构造 ask' +
      '（`git grep -nw askId -- src ../../apps/desktop/src` 只命中 agent-ask.ts 自己），' +
      '所以它"死"是整个 ask 子系统上游未接线的症状，不是一个游离导出。要么接上产出方，要么整族删掉——' +
      '两者都不该由这道门单方面决定。'
  },
  {
    module: 'src/agent-ask.ts',
    name: 'timeOutAsk',
    barrel: true,
    premise:
      '同 openAsk：经 barrel 公开的 ask 超时收尾，而本仓没有任何生产代码构造 ask。' +
      '两个入口一起进退——只删其中一个会留下一半能开不能超时的 API。'
  },
  {
    module: 'src/execution-host.ts',
    name: 'ExecutionHostRegistry',
    barrel: true,
    premise:
      '经 barrel 公开的注册表，同模块的 LocalExecutionHost / SshExecutionHost 有真生产消费者' +
      '（apps/desktop/src/main/host-factory.ts）。多宿主接线尚未走到需要注册表的那一步。'
  },
  {
    module: 'src/providers/shared.ts',
    name: 'HOOK_INSTALLATION_BY_PROVIDER',
    premise: 'Type-level SSOT: ProviderRequiringManagedHookResolver derives the required resolver keys from this table; provider-conformance.test.ts checks every entry against the live provider catalogs. It has no runtime consumer by design.'
  },
  {
    module: 'src/providers/pi.ts',
    name: 'PI_HOOK_EVENTS',
    premise:
      '它不是死代码而是**判据的锚点**：test/providers/pi.test.ts 用它逐个断言七个事件名' +
      '真的出现在生成的扩展源码里（声明 ↔ 生成代码的漂移守卫），' +
      'test/agent-provider-protocol.test.ts 也按它核对 provider 自报的事件名。' +
      '删掉它等于删掉那两道守卫。真正该做的是让 PI_HOOKS.rules 从它派生（另一次改动）。'
  }
]

function exemptionKey(module: string, name: string): string {
  return `${module}#${name}`
}

const EXEMPT = new Set(DELIBERATE.map((entry) => exemptionKey(entry.module, entry.name)))

describe('core src 的每个模块都没有零生产调用方的导出', () => {
  const modules = coreModules()
  const index = identifierIndex(consumerFiles())

  /** 模块 → 它的死导出。全包只建一次索引（每个消费文件恰好 parse 一次）。 */
  const deadByModule = new Map<string, string[]>()
  for (const modulePath of modules) {
    const dead = deadExportsIn(modulePath, index)
    if (dead.length > 0) deadByModule.set(relative(coreRoot, modulePath), dead)
  }

  it('每个值导出都从生产源码 / 入口 / 打包消费契约可达，或在豁免表里带着前提', () => {
    const offenders: string[] = []
    for (const [module, dead] of deadByModule) {
      const unexplained = dead.filter((name) => !EXEMPT.has(exemptionKey(module, name)))
      if (unexplained.length > 0) offenders.push(`${module}: ${unexplained.join(', ')}`)
    }
    expect(
      offenders.sort(),
      '这些导出在本文件之外零引用，也没有被任何活着的同模块绑定组合调用：\n' +
        `${offenders.join('\n')}\n` +
        '三条出路：接线（给它一个真消费者）、删掉它与它的测试、' +
        '或者进 DELIBERATE 豁免表——**但必须写清可断言的前提**，' +
        '"刻意保留"不是前提。注意「同一个文件里又出现了一次」不算引用（#580）。'
    ).toEqual([])
  })

  it('自检 1：扫描面与模块面都非空，且判据数得出"零引用"', () => {
    // 扫描根写错（比如 collect 静默返回空）时，上面那条会在空集上恒绿——这是"扫描根写错静默变绿"
    // 那一族。这里同时钉住两侧的规模下界，以及"死"这个结论真的可达。
    expect(modules.length, 'core src 一个模块都没扫到——扫描根写错了').toBeGreaterThan(50)
    expect(index.size, '消费面一个文件都没扫到——扫描根写错了').toBeGreaterThan(300)
    const probeModule = join(coreRoot, 'src', 'errors.ts')
    expect(modules, 'errors.ts 不在模块面里——它正是本门存在的原因').toContain(probeModule)
    // 一个保证不存在的名字必须被判成死：若引用检测因为读取退化而永远命中，这条会红。
    const synthetic = parse(
      'probe.ts',
      'export const AgentMuxSymbolThatIsNotReferencedAnywhere_errors = 1'
    )
    expect(valueExportsOf(synthetic)).toEqual([
      'AgentMuxSymbolThatIsNotReferencedAnywhere_errors'
    ])
    let seeded = 0
    for (const names of index.values()) {
      if (names.has('AgentMuxSymbolThatIsNotReferencedAnywhere_errors')) seeded += 1
    }
    expect(seeded, '一个不存在的名字在消费面里被"引用"到了——引用检测整体失明').toBe(0)
  })

  it('自检 2：被测模块自己被排除掉了——把索引缩成只有它自己时，它的导出必须全被判死', () => {
    // #580 那次假绿的直接位点，只是这次搬到了结构里：deadExportsIn 靠**索引键与模块路径全等**来
    // 跳过定义文件。若两边的路径拼法哪天不一致（一个绝对一个相对、一个带 ./），skip 静默变成
    // no-op，每个导出都会被自己的定义行判活，整道门恒绿。
    //
    // 判据是**功能性**的，不是前提性的：喂一个只含被测模块自己的索引，然后要求"全死"。
    // 只断言"模块在索引里"（skip 的前提）不够——前提成立而 skip 不生效正是要抓的那件事。
    // 实测：删掉 deadExportsIn 里那句 `continue`，本条红。
    const probeModule = join(coreRoot, 'src', 'errors.ts')
    const selfOnly = new Map([[probeModule, index.get(probeModule)!]])
    const exported = valueExportsOf(parse(probeModule, readFileSync(probeModule, 'utf8')))
    expect(exported.length, 'errors.ts 一个值导出都没抽到——探针本身退化了').toBeGreaterThan(0)
    expect(
      deadExportsIn(probeModule, selfOnly).sort(),
      '扫描面只有被测模块自己时它的导出竟然"活着"——deadExportsIn 的"跳过自己"没生效，' +
        '种子集合会被定义行顶满，整道门恒绿'
    ).toEqual([...exported].sort())
    // 前提也顺手守一遍：真实扫描里每个模块都必须在索引里，否则那个 skip 无从发生。
    const missing = modules.filter((modulePath) => !index.has(modulePath))
    expect(
      missing.map((path) => relative(coreRoot, path)),
      '这些模块不在消费面索引里，deadExportsIn 的"跳过自己"于是无从发生'
    ).toEqual([])
  })

  it('自检 3：豁免表里的每条都还指着一个真实存在的导出', () => {
    // 重命名/删除之后，表里的名字会变成虚构，而虚构的豁免不会红——它只是永远不匹配任何东西，
    // 让表看起来还在守着什么。
    const stale: string[] = []
    for (const entry of DELIBERATE) {
      const modulePath = join(coreRoot, entry.module)
      const exported = valueExportsOf(parse(modulePath, readFileSync(modulePath, 'utf8')))
      if (!exported.includes(entry.name)) stale.push(exemptionKey(entry.module, entry.name))
    }
    expect(stale, '豁免表里这些条目指向不存在的导出——重命名或删除之后表没跟上').toEqual([])
  })

  it('自检 4：豁免表里的每条都**仍然**是死的，且它声称的前提今天还成立', () => {
    // 两个方向各守一次：
    //   - 一条豁免若已经接上真消费者，它就该从表里删掉。否则表只增不减，最后变成一份"允许清单"，
    //     而允许清单是我记忆里那族「禁止/允许清单必漏」的另一半。
    //   - `barrel: true` 声称的前提（经 src/index.ts 公开）必须真的在场；前提没了，豁免的理由也没了。
    const barrel = readFileSync(barrelPath, 'utf8')
    const noLongerDead: string[] = []
    const brokenPremise: string[] = []
    for (const entry of DELIBERATE) {
      const dead = deadByModule.get(entry.module) ?? []
      if (!dead.includes(entry.name)) noLongerDead.push(exemptionKey(entry.module, entry.name))
      if (entry.barrel) {
        const moduleSpecifier = `./${entry.module.replace(/^src\//, '').replace(/\.ts$/, '.js')}`
        if (!barrel.includes(`export * from '${moduleSpecifier}'`)) {
          brokenPremise.push(`${exemptionKey(entry.module, entry.name)} → ${moduleSpecifier}`)
        }
      }
      expect(entry.premise.length, `${entry.name} 的豁免前提太短，写不出一句能被质询的话`)
        .toBeGreaterThan(40)
    }
    expect(
      noLongerDead,
      '这些豁免已经不需要了——它们现在有真消费者了。把它们从 DELIBERATE 里删掉，' +
        '别让豁免表变成只增不减的允许清单'
    ).toEqual([])
    expect(
      brokenPremise,
      '这些豁免声称"经 barrel 公开"，但 src/index.ts 里已经没有那条 export *——前提没了，豁免也该没了'
    ).toEqual([])
  })

  it('自检 5：引擎注释举的「非导出中间层」见证今天逐条都还成立', () => {
    // 为什么这条断言存在：那段注释此前的第三个例子（`AGENT_PROMPT_DELIVERY_INTERRUPTED` 只被非导出的
    // `mapInterruptedPromptDelivery()` 用）**全仓只存在于那句注释里**——两个名字都早已不在源码中。
    // 注释里的举例没有读者，所以它从真实变成虚构的那一刻没有任何东西会红；一个读起来很具体的例子
    // 反而让人以为这条盲点已经被守住了。把见证搬成数据，再由本条逐个质询它声称的那三件事。
    const offenders: string[] = []
    for (const witness of NON_EXPORTED_INTERMEDIARY_WITNESSES) {
      const modulePath = join(coreRoot, witness.module)
      const sourceFile = parse(modulePath, readFileSync(modulePath, 'utf8'))
      const exported = new Set(valueExportsOf(sourceFile))
      const bindings = topLevelBindings(sourceFile)
      const key = `${witness.module}#${witness.export} ← ${witness.intermediary}`
      if (!exported.has(witness.export)) {
        offenders.push(`${key}：被举例的导出已不存在（重命名或删除了）`)
      }
      if (!bindings.has(witness.intermediary)) {
        offenders.push(`${key}：中间层已不是这个模块的顶层绑定`)
        continue
      }
      // 中间层**必须仍是非导出**，否则这条见证不再见证任何东西：只沿导出传递也能走到它。
      if (exported.has(witness.intermediary)) {
        offenders.push(`${key}：中间层现在是导出了，这条见证不再证明「必须收非导出绑定」`)
      }
      const refs = compositionEdges(sourceFile).get(witness.intermediary) ?? new Set<string>()
      if (!refs.has(witness.export)) {
        offenders.push(`${key}：中间层的声明体里已经不引用这个导出了`)
      }
    }
    expect(
      offenders,
      'export-reachability.ts 头部注释声称的「非导出中间层」见证已与源码脱节：\n' +
        `${offenders.join('\n')}\n` +
        '要么更新 NON_EXPORTED_INTERMEDIARY_WITNESSES，要么删掉过时的那条——' +
        '别让它退化成一句读起来很具体的虚构举例。'
    ).toEqual([])
    expect(NON_EXPORTED_INTERMEDIARY_WITNESSES.length, '见证表空了，上面那个循环整体空转').toBeGreaterThan(0)
    // 反向自检：三个判据各自都得**认得出**违约形状，否则上面的循环可能恒绿。
    const probe = parse('probe.ts', 'export const A = 1\nexport const B = [A]\nconst C = [A]\nconst D = 2\n')
    const probeExports = new Set(valueExportsOf(probe))
    expect(probeExports.has('B'), '探针的 B 应当被认成导出（否则"中间层是导出"这条判据恒不触发）').toBe(true)
    expect(probeExports.has('C'), '探针的 C 应当被认成非导出').toBe(false)
    expect(topLevelBindings(probe).has('C'), '探针的 C 应当在顶层绑定里').toBe(true)
    expect(compositionEdges(probe).get('C')?.has('A'), '探针里 C 的声明体应当引用 A').toBe(true)
    expect(compositionEdges(probe).get('D')?.has('A'), '探针里 D 不引用 A，引用判据要认得出这一侧').toBe(false)
  })
})
