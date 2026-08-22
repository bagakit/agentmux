import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const renderer = new URL('../src/renderer/src/', import.meta.url).pathname

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

it('renders the global switch only in the window footer, including Session layout paths', () => {
  const files = sourceFiles(renderer)
  expect(files.length).toBeGreaterThan(0)
  const calls: { file: string; container: string | undefined }[] = []
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === 'SurfaceSwitch') {
        const parent = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent
        const className = ts.isJsxElement(parent)
          ? parent.openingElement.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className')
          : undefined
        calls.push({
          file: relative(renderer, file),
          container: className && ts.isJsxAttribute(className) && className.initializer && ts.isStringLiteral(className.initializer)
            ? className.initializer.text : undefined
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(calls).toEqual([{ file: 'App.tsx', container: 'window-status-bar__surface-switch' }])
})
