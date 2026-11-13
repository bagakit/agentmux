import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/** Shared introductions keep their prose outside containers that restyle paragraphs as footnotes. */
// A summary owns its prose, while these containers intentionally style ordinary child paragraphs as footnotes.
const FOOTNOTE_CONTAINERS = ['settings-card', 'workspace-composer']
const SUMMARY_COMPONENT = 'SettingsConceptSummary'

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

/** 遍历一个组件的 JSX，收集每个 `SettingsConceptSummary` 元素及其 className 祖先链（外→内，不含自身）。 */
function leadSites(file: string): LeadSite[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const relative = file.slice(SETTINGS_DIR.length + 1)
  const sites: LeadSite[] = []

  function walk(node: ts.Node, ancestorClasses: string[]): void {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined
    let nextAncestors = ancestorClasses
    if (opening) {
      const className = classNameText(opening, source)
      if (opening.tagName.getText(source) === SUMMARY_COMPONENT) sites.push({ file: relative, ancestors: ancestorClasses })
      nextAncestors = [...ancestorClasses, className]
    }
    ts.forEachChild(node, (child) => walk(child, nextAncestors))
  }

  walk(source, [])
  return sites
}

describe('shared Settings introductions preserve their prose hierarchy', () => {
  const sites = settingsPaneFiles().flatMap(leadSites)

  it('keeps every connected summary contribution outside footnote containers', () => {
    // 挡板：一个 lead 都没扫到就说明解析或选择器错了、判据失效——直接红，不许静默通过。
    expect(sites.length, '没有扫到任何 SettingsConceptSummary，导语判据失效').toBeGreaterThan(0)

    for (const site of sites) {
      const offending = site.ancestors.filter((className) =>
        FOOTNOTE_CONTAINERS.some((container) => hasClass(className, container))
      )
      expect(offending, `${site.file}: SettingsConceptSummary 嵌在 ${offending.join(' / ')} 内——会被 .settings-card p 的脚注样式按特异度压掉`)
        .toEqual([])
    }
  })
})
