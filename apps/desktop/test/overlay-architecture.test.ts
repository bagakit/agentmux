// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const roots = ['apps/desktop/src/renderer/src', 'apps/mobile/src', 'packages/client-ui/src']
const owner = 'packages/client-ui/src/components/Modal.tsx'
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : /\.(?:tsx?|css)$/.test(path) ? [path] : []
  })
}

it('routes every product Dialog through the shared owner, including newly added consumers', () => {
  const direct: string[] = [], consumers: string[] = [], manualDialogRanks: string[] = []
  for (const file of roots.flatMap(path => files(join(root, path))).filter(path => /\.tsx?$/.test(path))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue
      const specifier = statement.moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier)) continue
      if (specifier.text === '@radix-ui/react-dialog') direct.push(relative(root, file))
      if (specifier.text === '@agentmux/client-ui/components/Modal' || /^\.\/Modal(?:\.js)?$/.test(specifier.text)) consumers.push(relative(root, file))
    }
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'data-overlay-layer' &&
        node.initializer && ts.isStringLiteral(node.initializer) && node.initializer.text === 'dialog')
        manualDialogRanks.push(relative(root, file))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(new Set(direct)).toEqual(new Set([owner]))
  expect(manualDialogRanks).toEqual([])
  // A missing source root or empty scan must fail; the list is derived, never a component registry.
  for (const directory of roots) expect(consumers.some(file => file.startsWith(directory))).toBe(true)
})

it('keeps global layer values in one shared stylesheet and removes retired visibility state', () => {
  const declarations: string[] = [], legacy: string[] = [], derivedWindowRanks: string[] = []
  for (const file of roots.flatMap(path => files(join(root, path)))) {
    const source = readFileSync(file, 'utf8')
    if (file.endsWith('.css') && /--layer-[\w-]+\s*:/.test(source)) declarations.push(relative(root, file))
    if (/\b(?:nativeSurfaceOverlayCount|portalOverlayCount|acquireNativeSurfaceOverlay|releaseNativeSurfaceOverlay)\b/.test(source)) legacy.push(relative(root, file))
    if (/calc\(var\(--layer-/.test(source)) derivedWindowRanks.push(relative(root, file))
  }
  expect(declarations).toEqual(['packages/client-ui/src/styles/overlays.css'])
  expect(legacy).toEqual([])
  expect(derivedWindowRanks).toEqual([])
  for (const host of ['apps/desktop/src/renderer/src/styles/tokens.css', 'apps/mobile/src/mobile.css'])
    expect(readFileSync(join(root, host), 'utf8')).toContain('@agentmux/client-ui/styles/overlays.css')
})
