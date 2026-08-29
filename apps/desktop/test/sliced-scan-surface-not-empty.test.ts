import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  packageRootsWithTestsOnDisk,
  workspaceTestFiles
} from './helpers/workspace-test-files.js'

/**
 * `indexOf` 取出来的扫描面不许是空的。
 *
 * 本仓大量断言长这个形状——从源码里切出一段，再判这一段里**没有**某个东西：
 *
 * ```ts
 * const row = source.slice(source.indexOf('<Foo'), source.indexOf('</Foo>'))
 * expect(row).not.toContain('bad thing')
 * ```
 *
 * 起锚点一旦在源码里不存在，`indexOf` 返回 **-1**，`slice(-1, j)` 在 j 小于 len-1 时得到**空串**
 * （`slice` 把负数换算成 `len-1`，起点跑到末尾之后）。于是 `not.toContain` 恒真：判据在盘上、
 * 名字读着有主、`grep` 命中，实际一个字符都没扫。这是 AGENTS.md:85-88 点名的第三种白绿，
 * 而且是其中最难发现的一支——**红是运气好，静默全绿才是常态**。
 *
 * 来由（实测）：`topic-agent-status.test.ts` 判「头像逐个在场后不再另给一个计数」，起锚点写的是
 * `className="workspace-topic-agents"`。那个类名在头像簇换成共享的 `SelectorPresence` 时就没了
 * （`6b0bc0a9`，2026-08-15），此后这条判据扫的一直是空串。性质本身仍然成立，所以没有任何东西
 * 会红——它只是停止了工作，整整一个月没人知道。
 *
 * ── 为什么是检测器而不只是那一次修正 ──
 *
 * 改类名、换共享组件、把一段 JSX 挪进别的组件，都是常规动作，每一次都可能让某个锚点落空。
 * 而这件事对现有一切工具全盲：`tsc` 干净（字符串字面量永远合法）、测试全绿（断言恒真）、
 * code review 看不出（锚点长得像还在的样子）。常驻规则的交付物是守卫，不是那一次清理。
 *
 * ── 判据的取值面 ──
 *
 * 只认**能静态解析出两端**的那种：`const x = readFileSync(new URL('../src/renderer/src/…'))`
 * 读进来的字符串，被 `x.indexOf('字面量')` 取锚点。这一对齐全时，锚点在不在目标文件里是可判定的
 * 事实，不需要跑测试。判不了的（锚点是变量、是拼接、源不是从 URL 读的）一概跳过——宁可漏报，
 * 不误伤：误伤会让人给判据加豁免，而豁免会把这条守卫吃掉。
 */
describe('切出来的扫描面不是空的', () => {
  /**
   * `const <name> = readFileSync(\n? new URL('<../>+<path>'` —— 允许换行与空白。
   *
   * 覆盖 `src/` **整棵树**而不只是 `renderer/src/`：`main/` 那一侧才是 `ipc.ts`、
   * `browser-view-manager.ts` 这些靠切片判据守着的文件所在的地方，把它排除在外等于在守卫自己身上
   * 留一块盲区（实测：全仓 104 处绑定里 14 处在 renderer 之外，12 处在 `main/`）。
   *
   * 上溯层数是 `(\.\.\/)+` 而不是写死一层的 `\.\.\/src\/`：扫描面递归之后，
   * `packages/core/test/providers/kimi.test.ts` 这类子目录里的文件读源码写的是 `'../../src/…'`，
   * 钉死一层会把它们整批漏掉——而漏掉时没有任何东西会红。目标目录名也不再钉 `src/`：
   * `stylesheet-organisation.test.ts` 读的是 `'../../../docs/design/…'`，那同样是一份「锚点落空就
   * 静默恒真」的扫描面，没有理由不守。
   */
  const SOURCE_BINDING_RE = /const\s+(\w+)\s*=\s*readFileSync\(\s*new URL\(\s*'((?:\.\.\/)+[^']+)'/g
  /** `<var>.indexOf('<literal>'` —— 只认单引号字面量。 */
  const INDEX_OF_RE = /(\w+)\.indexOf\(\s*'((?:[^'\\]|\\.)*)'/g

  /** 把 TS 源里的单引号字面量还原成它在运行时的值（`\'`、`\\`、`\n` 这些）。 */
  function unescape(literal: string): string {
    return literal.replace(/\\(['\\nrt])/g, (_, char: string) =>
      char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
    )
  }

  const testFiles = workspaceTestFiles()

  it('扫描面自检：全部 workspace test 树读得到，且里面真有这种取锚点的写法', () => {
    // 这条判据自己也是扫描式的，所以它自己也得证明扫到了东西——否则它正是它要防的那种东西。
    expect(testFiles.length, 'workspace test 树扫出来是空的').toBeGreaterThan(700)

    // 只数文件总数挡不住**丢掉一整个包**：apps/desktop 一家就有近 600 个文件，把 packages/* 从
    // workspace 声明里删掉，总数仍然过任何合理阈值。所以再拿一个独立来源（磁盘上直接找带 test 树
    // 的包目录）对一次——两个来源只在缺陷处分岔。
    const declaredRoots = [...new Set(testFiles.map((file) => file.relPath.slice(0, file.relPath.indexOf('/test/'))))]
    expect(declaredRoots.sort(), 'workspace 声明派生出的包与磁盘上带 test 树的包对不上').toEqual(
      packageRootsWithTestsOnDisk()
    )

    const withAnchors = testFiles.filter((file) => {
      const text = readFileSync(file.absPath, 'utf8')
      SOURCE_BINDING_RE.lastIndex = 0
      INDEX_OF_RE.lastIndex = 0
      return SOURCE_BINDING_RE.test(text) && INDEX_OF_RE.test(text)
    })
    expect(
      withAnchors.length,
      '「从源码读字符串再 indexOf 取锚点」的文件扫得太少——两条正则里至少有一条不认当前写法了'
    ).toBeGreaterThan(25)
  })

  it('每个 indexOf 锚点都真的出现在它所读的那个源文件里', () => {
    const sourceCache = new Map<string, string | null>()
    const readSource = (dirUrl: URL, relative: string): string | null => {
      const key = new URL(relative, dirUrl).pathname
      if (!sourceCache.has(key)) {
        try {
          // 捕获到的是 `../…`，相对的是**那个测试文件自己所在的目录**——扫描面递归之后，
          // test/ 与 test/providers/ 下的文件上溯层数不同，拿单一基址去解析会整批错位。
          sourceCache.set(key, readFileSync(key, 'utf8'))
        } catch {
          // 源文件本身没了是另一条判据的事（那种情况 readFileSync 会在真测试里直接抛），这里跳过。
          sourceCache.set(key, null)
        }
      }
      return sourceCache.get(key) ?? null
    }

    const offenders: string[] = []
    let checked = 0
    for (const file of testFiles) {
      const text = readFileSync(file.absPath, 'utf8')

      // 先把「哪个变量读的哪个文件」收齐，再逐个 indexOf 去对。
      const boundTo = new Map<string, string>()
      SOURCE_BINDING_RE.lastIndex = 0
      for (let m = SOURCE_BINDING_RE.exec(text); m; m = SOURCE_BINDING_RE.exec(text)) {
        boundTo.set(m[1]!, m[2]!)
      }
      if (boundTo.size === 0) continue

      INDEX_OF_RE.lastIndex = 0
      for (let m = INDEX_OF_RE.exec(text); m; m = INDEX_OF_RE.exec(text)) {
        const relative = boundTo.get(m[1]!)
        if (relative === undefined) continue
        const source = readSource(file.dirUrl, relative)
        if (source === null) continue
        checked += 1
        const anchor = unescape(m[2]!)
        if (!source.includes(anchor)) {
          const line = text.slice(0, m.index).split('\n').length
          offenders.push(`${file.relPath}:${line} 在 ${relative} 里找不到锚点 ${JSON.stringify(anchor)}`)
        }
      }
    }

    // 判据非空自检：一对锚点都没核到的话，上面那个 `offenders` 空得毫无意义。
    // 阈值按放大后的扫描面重设（实测 91）：写 > 0 的话，扫描面从一个包扩到全仓后几乎不可能红，
    // 等于没守。
    expect(checked, '核到的锚点太少——绑定与 indexOf 没配上，这条判据基本没在检查').toBeGreaterThan(70)
    expect(
      offenders,
      '这些锚点在源文件里不存在，`indexOf` 返回 -1，切出来的是空串，之后的 `not.toContain` 恒真：\n' +
        offenders.join('\n')
    ).toEqual([])
  })
})
