import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { GH_UNAVAILABLE, GIT_UNAVAILABLE } from '../src/renderer/src/lib/git-bridge.js'

/**
 * 守的缺陷（#364 / #365）：「preload 桥在不在」这一个判断在渲染层被独立手抄了四次，三种写法。
 *
 * - `store.ts` 与 `useGitStatus.ts`：`window.agentmux?.git` 加判缺席，并各自**又抄了一遍**同一句
 *   'Git is unavailable in this build.'。
 * - `ChangesPanel.tsx` 两处：`window.agentmux!.git`，非空断言。桥缺席时点 Stage / Commit 抛裸
 *   `TypeError`，而**同一屏上** `useGitStatus` 对**同一个桥**好好地报了「不可用」。同一个前提被判出
 *   两种结论，一处说「这个 build 里没有 git」，一处直接崩——这就是手抄的代价。
 *
 * 为什么这一族没有类型层的强制力：git / gh 刻意只活在 `AgentMuxPreloadApi` 上而**不在**共享的
 * `AgentMuxDesktopApi` 上（contracts.ts:900-932 写明了理由：web preview 没有有意义的 git mock）。
 * 于是渲染层拿桥的唯一途径就是摸 `window`，而摸 `window` 这件事 `tsc` 永远不会反对。这是刻意的设计，
 * 不是疏漏；代价就是没有任何东西把调用点推向同一个取值口。**这条守卫就是那个缺失的强制力。**
 *
 * 判据：`src/renderer/` 里读 `agentmux` 这个属性的地方，只允许是下面 {@link ALLOWED} 那两个。
 *
 * 为什么这一条就够，不用再逐个调用点判「你的桥是不是从 lookup 来的」：一旦没人再摸 `window`，
 * 拿到桥的唯一出口就是 {@link gitBridge} / {@link ghBridge}，而它们返回的是**带标签的联合**——
 * `lookup.bridge` 在收窄之前根本读不出来，`tsc` 会拦。也就是说「非空断言绕过缺席判断」这条老路，
 * 在这条守卫成立之后由类型系统自己封住了。再加一层遍历调用点的检查只是不可能变红的死代码
 * （记忆 surviving-mutation-may-be-dead-condition：先判它可不可能改变结果，是就别写）。
 *
 * 判据落在 **AST** 上而不是文本上，这一点是承重的：`useGitStatus.ts:19`、`ChangesPanel.tsx:41`、
 * `store.ts:316/890` 的文档注释里都**正当地**写着 `window.agentmux.git` 这串字（在讲这个桥是什么）。
 * 一个 `readFileSync().toContain()` 形状的守卫会对这四处发假红，而假红久了必被加豁免、豁免再吃掉
 * 真缺陷（记忆 lexical-boundaries-need-a-real-lexer：注释边界要用语言自己的词法器判，别按行猜）。
 * 下面 `注释里提到不算读取` 那一条把这个区分本身做成了断言。
 */

const RENDERER = fileURLToPath(new URL('../src/renderer', import.meta.url))

/**
 * 允许摸 `agentmux` 的两个地方，各自的理由。
 *
 * 每条豁免都自带在场自检（见 `每条豁免都真的在用`）：一条指向不存在或已经不再摸 window 的文件的
 * 豁免是死代码，而死豁免会让人以为某处仍被允许（记忆 cleanup-without-a-detector-is-not-cleanup）。
 */
const ALLOWED: Record<string, string> = {
  'src/lib/git-bridge.ts': '收敛层本身——这一层存在的意义就是替所有人摸这一次',
  'src/lib/api.ts': 'requireDesktopApi：把 preload 面包成共享的 api，是另一条正当的单一入口'
}

type Read = { file: string; line: number }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/u.test(entry) ? [full] : []
  })
}

/**
 * 一个文件里所有**读 `agentmux` 属性**的位置。
 *
 * 刻意不判「根对象是不是 `window`」：`globalThis.agentmux`、`self.agentmux`、
 * `(window as any).agentmux`、`window['agentmux']` 都是同一件事的别的拼法，只钉住 `window.` 那一种
 * 等于给绕过留门（记忆 counting-a-symbol-misses-other-spellings）。所以判据是属性名本身，
 * 点号访问与下标访问两种都收。
 */
function agentmuxReads(file: string): Read[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Read[] = []
  const visit = (node: ts.Node): void => {
    const hit =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'agentmux') ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'agentmux')
    if (hit) {
      found.push({
        file: relative(RENDERER, file),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/** 一个文件里所有**字符串字面量**的取值。注释天然不在其中——这正是要的。 */
function stringLiterals(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

const FILES = sourceFiles(RENDERER)
const READS = FILES.flatMap((file) => agentmuxReads(file))

describe('preload 桥只有一个取值口', () => {
  it('渲染层没有别的地方再摸 agentmux', () => {
    const strays = READS.filter((read) => ALLOWED[read.file] === undefined)
    expect(
      strays.map((read) => `${read.file}:${read.line}`),
      '这里又长出了一处独立的桥取值。桥缺席时它会自己编一套说法（或者干脆用 `!` 断言然后崩）——' +
        '这正是 #364 的形状。改成从 lib/git-bridge 的 gitBridge() / ghBridge() 取。'
    ).toEqual([])
  })

  // 在场自检：上面那条断言在「一个都没找到」时也会通过。遍历一旦坏掉（改错后缀、走错根目录），
  // 整条守卫就静默变恒真（记忆 false-green-gate-patterns 里「扫描根写错静默变绿」那一条）。
  it('遍历真的看见了源码和取值点', () => {
    expect(FILES.length, 'renderer 下一个源文件都没扫到——扫描根或后缀写错了').toBeGreaterThan(50)
    expect(READS.length, '一处 agentmux 取值都没找到——AST 判据坏了，上面那条已经恒真').toBeGreaterThan(0)
  })

  it('每条豁免都真的在用', () => {
    // 一条没人再用的豁免要删掉，而不是留着。豁免的前提（「这个文件仍是一个正当的取值口」）必须
    // 自己可被质询，否则清单会慢慢变成一份谁也不敢动的许可名单。
    const used = new Set(READS.map((read) => read.file))
    for (const [file, why] of Object.entries(ALLOWED)) {
      expect(used.has(file), `豁免 ${file}（${why}）已经不摸 agentmux 了——把这条豁免删掉`).toBe(true)
    }
  })

  /**
   * 判据是词法的，不是文本的——把这个区分本身做成断言。
   *
   * 有若干文件的**文档注释**里正当地写着 `window.agentmux.git`（在解释这个桥是什么）。它们必须
   * 贡献零个取值点。这一条同时证明两件事：AST 判据没有退化成 `toContain`，以及那些注释不需要豁免。
   */
  it('注释里提到 window.agentmux 不算读取', () => {
    const mentionsInProse = FILES.filter((file) => {
      if (ALLOWED[relative(RENDERER, file)] !== undefined) return false
      return readFileSync(file, 'utf8').includes('window.agentmux') && agentmuxReads(file).length === 0
    })
    expect(
      mentionsInProse.length,
      '没有任何文件是「注释里提到但代码里不读」——这条自检的前提不在场了，' +
        '它已经不能证明判据是词法的。去找一处这样的注释，或者删掉这条断言。'
    ).toBeGreaterThan(0)
  })
})

describe('桥缺席时那句话也只有一处', () => {
  // 两句话从模块自己的导出取，不在测试里手抄一遍：改措辞不该需要改测试，而手抄一份恰恰是被守的
  // 那个缺陷本身（记忆 expected-value-must-not-derive-from-mutation-target 的反面：这里要守的是
  // 「只有一处」，所以取值必须来自那一处）。
  const messages = { GIT_UNAVAILABLE, GH_UNAVAILABLE }

  it('两句都只作为字面量出现一次，且在收敛层里', () => {
    for (const [name, message] of Object.entries(messages)) {
      const sites = FILES.filter((file) => stringLiterals(file).includes(message))
        .map((file) => relative(RENDERER, file))
      expect(sites, `${name} 被抄了（或者搬走了）。缺席时对用户说什么，只能有一处定义。`)
        .toEqual(['src/lib/git-bridge.ts'])
    }
  })

  it('git 与 gh 缺席不是同一句话', () => {
    // 刻意分开：git 不可用是「这个 build 里看不了改动」，gh 不可用是「开 PR 需要桌面端」——用户的
    // 下一步不同。合成一句会把两个处境说成同一件事。
    // 这条只挡「折成同一个字面量」这一种。两句话是不是真的说了两件不同的事，是人的判断，理由记在
    // git-bridge.ts 的注释里（记忆 near-identical-copy-defeats-distinct-classes：not.toBe 只能证
    // 逐字不等，证不了语义有别）。
    expect(GH_UNAVAILABLE).not.toBe(GIT_UNAVAILABLE)
  })
})
