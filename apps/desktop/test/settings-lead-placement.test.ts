import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 守的缺陷（#584 复核时发现）：`.settings-lead` 是每个设置面的导语——`--fs-prose` / `--text-2`。
 * 但 `.settings-card p` / `.workspace-composer p` 把卡片里的 `<p>` 按脚注排（`--fs-meta` / `--text-3`），
 * 且选择器特异度更高（0,1,1 > 0,1,0）。所以只要把导语**嵌进** `.settings-card` 里，级联就判脚注赢，
 * 导语悄悄塌成脚注字号、褪成脚注色——恰好抹掉这一格「导语 vs 脚注」的层级，而这正是它存在的理由。
 * 事故形态：GeneralSettingsPane 曾把 `<p class="settings-lead">` 放在 `<section class="settings-card">`
 * 内部，另外两个面则把它放在 `.settings-pane-stack` 直属层，于是只有 General 那句读起来更小更暗。
 *
 * 判据不是「导语在场」也不是文本级 grep 祖先关系（按行猜嵌套是一整族盲点），而是用真正的 TS/JSX
 * 解析器走一遍：任何带 `settings-lead` 的元素，其 JSX 祖先里不许出现按脚注排版的容器
 * （`settings-card` / `workspace-composer`）。这条级联缺陷 renderToStaticMarkup 看不见（它不算特异度），
 * 现有 rendered-class-has-rule 也看不见（class 都有规则、都渲染了），所以单独立此守卫。
 */

// 会把直接 `<p>` 子孙按脚注排版、从而在特异度上压过 .settings-lead 的容器。
const FOOTNOTE_CONTAINERS = ['settings-card', 'workspace-composer']
const LEAD_CLASS = 'settings-lead'

const SETTINGS_DIR = fileURLToPath(new URL('../src/renderer/src/components/settings', import.meta.url))

function settingsPaneFiles(): string[] {
  return readdirSync(SETTINGS_DIR)
    .filter((name) => name.endsWith('Pane.tsx'))
    .map((name) => `${SETTINGS_DIR}/${name}`)
}

/** 读一个 JSX 开标签上 className 的**源码文本**（字面量、模板、表达式都原样取），没有则空串。 */
function classNameText(opening: ts.JsxOpeningLikeElement, source: ts.SourceFile): string {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(source) !== 'className' || !attr.initializer) continue
    if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
      return attr.initializer.expression.getText(source)
    }
  }
  return ''
}

function hasClass(text: string, className: string): boolean {
  return text.split(/\s+/).includes(className)
}

type LeadSite = { file: string; ancestors: string[] }

/** 遍历一个组件的 JSX，收集每个 `.settings-lead` 元素及其 className 祖先链（外→内，不含自身）。 */
function leadSites(file: string): LeadSite[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const relative = file.slice(SETTINGS_DIR.length + 1)
  const sites: LeadSite[] = []

  function walk(node: ts.Node, ancestorClasses: string[]): void {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined
    let nextAncestors = ancestorClasses
    if (opening) {
      const className = classNameText(opening, source)
      if (hasClass(className, LEAD_CLASS)) sites.push({ file: relative, ancestors: ancestorClasses })
      nextAncestors = [...ancestorClasses, className]
    }
    ts.forEachChild(node, (child) => walk(child, nextAncestors))
  }

  walk(source, [])
  return sites
}

describe('设置面导语不被卡片脚注样式吃掉', () => {
  const sites = settingsPaneFiles().flatMap(leadSites)

  it('每个 .settings-lead 都在脚注容器之外', () => {
    // 挡板：一个 lead 都没扫到就说明解析或选择器错了、判据失效——直接红，不许静默通过。
    expect(sites.length, '没有扫到任何 .settings-lead，导语判据失效').toBeGreaterThanOrEqual(3)

    for (const site of sites) {
      const offending = site.ancestors.filter((className) =>
        FOOTNOTE_CONTAINERS.some((container) => hasClass(className, container))
      )
      expect(offending, `${site.file}: .settings-lead 嵌在 ${offending.join(' / ')} 内——会被 .settings-card p 的脚注样式按特异度压掉`)
        .toEqual([])
    }
  })
})
