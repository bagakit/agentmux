import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  terminalCopyOutcome,
  terminalScrollbackText,
  terminalViewportText,
  type TerminalBufferLine,
  type TerminalBufferSnapshot
} from '../src/renderer/src/lib/terminal-buffer-copy'

/**
 * 原则 13 在这条复制路上的兑现：**判据是缓冲区模型，不是哪个 Agent 在跑**。
 *
 * 为什么这道门非有不可：这个缺陷是被一个具体 Provider 暴露出来的——用户报的是"某个 Agent 能复制、
 * 另一个不能"。那种报法最容易被写成针对它的分支（`if (provider === '…') useNormalBuffer()`），
 * 而那样写**今天也能修好用户看见的那一例**，于是没有任何测试会红。真实的判据是
 * "有没有程序占着 alternate buffer"——任何全屏 TUI 都会，与它是谁无关。
 *
 * 这道门守两件事：
 *  1. 实现与它的调用点里**不出现任何 Provider 名**（扫描，带在场自证）；
 *  2. 规则用**两种不同的 alternate-buffer 触发形态**各验证一次（行为，防过拟合到单一场景）。
 *
 * 第 1 条是扫描式判据，所以必须自己断言"扫到了东西"：扫到空内容是第三种白绿
 * （AGENTS.md 里点名的那一支），而它比被测的缺陷更严重——文件改名、类名搬走，
 * `not.toContain` 会在一个空串上恒真。
 */

/** 被扫描的那一面：取值实现本身，加上它唯一的两个调用点所在的文件。 */
const SCANNED = [
  '../src/renderer/src/lib/terminal-buffer-copy.ts',
  '../src/renderer/src/components/TerminalContextMenu.tsx'
].map((relative) => {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  return { path, source: readFileSync(path, 'utf8') }
})

/**
 * 不许出现的名字。
 *
 * 只列**本仓真实存在的 Provider**（AGENTS.md 点名的那一批），不试图穷举"所有可能的厂商名"——
 * 禁止清单必漏，这条清单的价值不在覆盖率，而在于它钉住了"这一层不该知道 Provider 是谁"这件事：
 * 真要写厂商分支的人，第一反应写的就是这几个名字之一。
 *
 * 大小写不敏感地匹配，因为同一个名字在配置侧与投递侧有两种拼法
 * （记忆 two-surface-provider-name-spellings）。
 */
const PROVIDER_NAMES = ['codex', 'claude', 'traex', 'hermes', 'pi'] as const

/**
 * 匹配规则：**子串**，不是 `\b` 词边界。
 *
 * 初版写的是 `\bcodex\b`，一次变异当场证伪了它：植入 `codexScrollbackWorkaround` 之后 14 条全绿。
 * 因为 `codex` 后面紧跟 `S`——两个都是单词字符，中间**没有**词边界，于是正则不匹配。而那正是
 * 厂商分支最可能长的样子（没有人会把函数就叫 `codex`，都叫 `codexWorkaround`、`isClaudeSession`）。
 * 词边界在这里恰好对最该抓的那一类失明。
 *
 * `pi` 这个名字太短，子串匹配会误伤（`api`、`copy`、`pipe`、`mapping`……），所以**只有它**保留
 * 词边界。这是按名字点名的破例，不是按值放行整张表：其余四个都走子串。
 */
const SHORT_NAMES_NEEDING_WORD_BOUNDARY = new Set(['pi'])

function providerNamePattern(name: string): RegExp {
  return SHORT_NAMES_NEEDING_WORD_BOUNDARY.has(name)
    ? new RegExp(`\\b${name}\\b`, 'iu')
    : new RegExp(name, 'iu')
}

/** 造一行缓冲行；`wrapped` 表示它是上一行的续行。 */
function line(text: string, wrapped = false): TerminalBufferLine {
  return {
    isWrapped: wrapped,
    translateToString: (trimRight?: boolean) => (trimRight === true ? text.replace(/\s+$/u, '') : text)
  }
}

function buffer(lines: readonly TerminalBufferLine[], viewportY = 0): TerminalBufferSnapshot {
  return { length: lines.length, viewportY, getLine: (index) => lines[index] }
}

describe('扫描：这一层不知道 Provider 是谁', () => {
  it('自证：扫描确有收获，每个被扫文件都非空', () => {
    // 扫到空内容是第三种白绿。文件改名、路径搬走，下面每条 `not.toContain` 都会在空串上恒真，
    // 而 tsc 干净、测试全绿、review 看不出（记忆 scan-cannot-tell-volatile-from-stable 的邻居）。
    expect(SCANNED.length, '扫描面是空的——下面每条断言都没有对象').toBeGreaterThan(0)
    for (const { path, source } of SCANNED) {
      expect(source.length, `${path} 读到的是空内容——对它的断言全部恒真`).toBeGreaterThan(0)
    }
  })

  it('自证：每个被扫文件里确实有这条复制路的锚点', () => {
    // 上一条只证"文件非空"。这一条证"扫的是对的那一段"：文件还在、内容还在，但这条能力被搬到
    // 别处去了，禁词扫描照旧全绿而它守的东西已经不在这儿了。
    const ANCHORS: Record<string, string> = {
      'terminal-buffer-copy.ts': 'terminalScrollbackText',
      'TerminalContextMenu.tsx': 'onCopyScrollback'
    }
    for (const { path, source } of SCANNED) {
      const file = path.split('/').at(-1)!
      const anchor = ANCHORS[file]
      expect(anchor, `${file} 没有登记锚点——这条自证漏掉了一个被扫文件`).not.toBeUndefined()
      expect(source, `${file} 里找不到锚点 ${anchor}——扫描面还在，但被守的能力已经不在这儿了`).toContain(
        anchor!
      )
    }
  })

  it('自证：匹配规则抓得住 "名字 + 后缀" 这种最常见的厂商分支写法', () => {
    // 这条是被一次变异逼出来的，不是补充说明：初版用 `\b<name>\b`，植入
    // `codexScrollbackWorkaround` 后 14 条全绿——`codex` 与 `S` 之间没有词边界。
    // 把规则改回词边界，这条当场红。
    for (const name of PROVIDER_NAMES) {
      if (SHORT_NAMES_NEEDING_WORD_BOUNDARY.has(name)) continue
      const pattern = providerNamePattern(name)
      expect(pattern.test(`${name}ScrollbackWorkaround`), `"${name}" 的匹配规则漏掉了带后缀的写法`).toBe(true)
      expect(pattern.test(`is${name[0]!.toUpperCase()}${name.slice(1)}Session`), `"${name}" 的匹配规则漏掉了带前缀的写法`).toBe(true)
    }
  })

  it('自证：短名字保留词边界，不会把 api/copy 这类无关词当成命中', () => {
    // 破例按名字点名（只有 pi），不按值放行整张表。这条钉住破例的两侧：它确实生效，
    // 而且它没有把 pi 这个名字本身放过。
    const pattern = providerNamePattern('pi')
    expect(pattern.test('const api = copy(pipe)'), '短名字的子串匹配会误伤无关标识符').toBe(false)
    expect(pattern.test('launch pi session'), '短名字连自己都匹配不到了').toBe(true)
  })

  for (const name of PROVIDER_NAMES) {
    it(`实现与调用点里不出现 "${name}"`, () => {
      // 逐个名字一条 `it`，不折成一条循环断言：折成一条时只有第一个命中的名字会被报出来，
      // 而且"这条判据到底检查了几个名字"从失败信息里读不出来。
      const pattern = providerNamePattern(name)
      for (const { path, source } of SCANNED) {
        const hit = source.split('\n').findIndex((row) => pattern.test(row))
        expect(
          hit,
          `${path}:${hit + 1} 出现了 Provider 名 "${name}"——` +
            '这一层的判据只能是缓冲区模型（谁占着 alternate buffer），不能是哪个 Agent 在跑'
        ).toBe(-1)
      }
    })
  }
})

describe('行为：规则在两种不同的 alternate-buffer 触发形态下都成立', () => {
  /**
   * 两种形态**不是同一件事换个数字**，这是这组断言的全部意义：
   *
   *  A. alternate 里有内容（全屏 TUI 正画着一屏界面）；
   *  B. alternate 是空的（TUI 刚清屏，或内容已滚出那一屏）。
   *
   * 只测 A 会过拟合："跟着 active 走"在 A 下拿到的是"错的内容"，在 B 下拿到的是"空串"——
   * 后者走的是完全不同的代码路径（空串 → 提示，而不是写剪贴板），漏掉它等于漏掉用户报的
   * 那一半症状（点了完全没反应）。
   */
  const history = [line('session line 1'), line('session line 2'), line('session line 3')]
  const RETAINED = 'session line 1\nsession line 2\nsession line 3'

  const SHAPES = [
    { name: 'alternate 里有内容（TUI 正画着一屏）', alternate: [line('╔ menu ╗'), line('╚══════╝')] },
    { name: 'alternate 是空的（TUI 刚清屏）', alternate: [] as TerminalBufferLine[] }
  ] as const

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('整段复制拿到 normal 的全部历史', () => {
        expect(terminalScrollbackText(buffer(history))).toBe(RETAINED)
      })

      it('整段复制的结局是"可写"，不是"取到空"', () => {
        // 两种形态下都必须能写进剪贴板。跟着 active 走时，形态 B 会走到 empty 那一支——
        // 提示是对的（比静默好），但它本不该发生：历史明明在 normal 里。
        expect(terminalCopyOutcome(terminalScrollbackText(buffer(history)), 'all')).toEqual({
          kind: 'copy',
          text: RETAINED
        })
      })

      it('可见输出读的是 alternate 那一屏，与历史无关', () => {
        const visible = terminalViewportText(buffer(shape.alternate), 24)
        expect(visible, '可见输出里混进了 normal 的历史——两档读成了同一块缓冲区').not.toContain(
          'session line 1'
        )
      })
    })
  }

  it('两种形态给出的可见输出互不相同——形态确实不同，不是同一个用例写了两遍', () => {
    // 自证。两个形态若恰好产出同一段文本，上面那组"各验一次"其实只验了一次，
    // 而"用两种触发形态证明没过拟合"这条验收就是假的。
    const [withContent, cleared] = SHAPES
    expect(
      terminalViewportText(buffer(withContent.alternate), 24),
      '两种 alternate 形态产出相同文本——它们没有构成两个不同的场景'
    ).not.toBe(terminalViewportText(buffer(cleared.alternate), 24))
  })
})
