import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 头像只收 `state` 这一个权威输入。这个文件守的是「没有第二个输入偷偷回来」。
 *
 * 病史：`SelectorPresenceAgent` 曾同时带 `state` 和 `attention`，于是两个调用方能对同一个 state
 * 各递一个不同的 attention（Topic 侧递 accent、Branch 侧硬写 null），组件照单全收——「waiting 画成
 * idle」就是这么静默发生的。修法是删掉那个字段，让注意力口径只由 `attentionAccentFor(state)` 在
 * 组件内部派生。
 *
 * 为什么删字段**不足以**把它钉住——这是本文件存在的全部理由，且是实测结论而非推理：
 *
 *   TypeScript 的 excess-property checking 只对**直接写出的对象字面量**生效。三形状探针实测：
 *     take([{ …, attention: null }])                    → error TS2353
 *     take(xs.map((x) => ({ …, attention: null })))      → 静默通过
 *     take(xs.map((x) => { return { …, attention: null } })) → 静默通过
 *   而两个调用方（SurfaceToolDock、BranchesPanel）**都**是 `.map()`。所以多写一个 attention 键，
 *   `tsc --noEmit` 从头到尾 exit 0。类型系统在这条路上帮不了忙。
 *
 * 判据因此落在 AST 上：凡是构造这些对象的地方，都不许出现那个属性名。文本判据（grep 'attention'）
 * 在这里没用——`data-attention`、`attentionAccentFor`、注释里的解释全会命中。
 */

const COMPONENTS_DIR = fileURLToPath(new URL('../src/renderer/src/components/', import.meta.url))

/** 组件目录下的每一个 .tsx。不写死文件清单：新加一个消费者不该悄悄逃出扫描面。 */
function componentFiles(): string[] {
  return readdirSync(COMPONENTS_DIR).filter((name) => name.endsWith('.tsx'))
}

function parse(name: string, source: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
}

/**
 * 传给 `<SelectorPresence agents={…}>` 的那个表达式子树里，所有对象字面量写出的属性名。
 *
 * 从 JSX 属性出发而不是从「所有对象字面量」出发：后者会把同文件里别的对象一起扫进来，于是这道门
 * 会对合法代码打假红。这里只看真正流进这个组件的那棵子树，`.map()` 回调在其中，所以恰好覆盖了
 * 类型检查够不着的那两种形状。
 */
function presenceAgentPropertyNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = []
  const collectFromSubtree = (root: ts.Node): void => {
    const walk = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
            names.push(property.name.text)
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(root)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'agents' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      isPresenceElement(node.parent.parent)
    ) {
      collectFromSubtree(node.initializer.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

/** 这个 JSX 标签是不是 `<SelectorPresence …>`（自闭合与成对两种形状都要认）。 */
function isPresenceElement(node: ts.Node): boolean {
  const tag = ts.isJsxSelfClosingElement(node)
    ? node.tagName
    : ts.isJsxOpeningElement(node)
      ? node.tagName
      : undefined
  return tag !== undefined && ts.isIdentifier(tag) && tag.text === 'SelectorPresence'
}

describe('SelectorPresence 的入参里不许有第二个注意力真相', () => {
  const sources = componentFiles().map((name) => ({
    name,
    ast: parse(name, readFileSync(new URL(name, `file://${COMPONENTS_DIR}`), 'utf8'))
  }))

  it('自检：扫描面真的看得见那两个调用方（否则下面整个循环空过）', () => {
    // 这条是本文件最容易失效的地方：提取器一旦看不懂新的写法，offenders 恒空，门永远绿。
    const withPresence = sources.filter(({ ast }) => presenceAgentPropertyNames(ast).length > 0)
    expect(
      withPresence.map(({ name }) => name).sort(),
      '认不出 <SelectorPresence agents={…}> 了——提取器瞎了，这道门此刻是恒真的'
    ).toEqual(['BranchesPanel.tsx', 'SurfaceToolDock.tsx'])
  })

  it('没有任何调用方写出 attention 键', () => {
    // tsc 挡不住这件事（`.map()` 回调里的对象字面量不做 excess-property 检查，见文件头实测记录），
    // 所以这里是唯一的判据。多写的键今天只是死数据，但它是「两个真相」那个缺陷的完整前半段。
    for (const { name, ast } of sources) {
      expect(
        presenceAgentPropertyNames(ast),
        `${name} 又给 SelectorPresence 递了 attention——注意力口径只有 attentionAccentFor(state) 一处`
      ).not.toContain('attention')
    }
  })

  it('自检：判据认得出「有人把 attention 加回去」这次变异', () => {
    // 没有这一条，上面那条可能只是恰好在一个它读不懂的形状上返回了空数组。用的正是类型检查器
    // 静默放过的那两种写法。
    const conciseArrow = parse(
      'probe.tsx',
      'const x = <SelectorPresence agents={xs.map((a) => ({ key: a.id, state: a.s, attention: null }))} />'
    )
    expect(presenceAgentPropertyNames(conciseArrow), '认不出简写箭头里的对象').toContain('attention')

    const blockArrow = parse(
      'probe.tsx',
      'const x = <SelectorPresence agents={xs.map((a) => { return { key: a.id, attention: f(a) } })} />'
    )
    expect(presenceAgentPropertyNames(blockArrow), '认不出块体箭头里的对象').toContain('attention')
  })

  it('自检：不误伤同文件里别的对象（判据只看流进这个组件的那棵子树）', () => {
    const unrelated = parse(
      'probe.tsx',
      'const row = { attention: 1 }\nconst x = <SelectorPresence agents={xs.map((a) => ({ key: a.id }))} />'
    )
    expect(
      presenceAgentPropertyNames(unrelated),
      '把不相干的对象也扫进来了——这道门会对合法代码打假红'
    ).toEqual(['key'])
  })
})
