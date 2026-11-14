import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')

function linkExits(text: string) {
  const tree = ts.createSourceFile('TerminalView.tsx', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const entries: Array<{ provider: string; exit: string | null }> = []
  const findActivation = (node: ts.Node): string | null => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'activate') {
      const value = node.initializer
      if (ts.isIdentifier(value)) return value.text
      if (ts.isArrowFunction(value) && ts.isCallExpression(value.body)) return value.body.expression.getText(tree)
    }
    return ts.forEachChild(node, child => findActivation(child) ?? undefined) ?? null
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'linkHandler') {
      entries.push({ provider: 'native', exit: findActivation(node.right) })
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'registerLinkProvider') {
      entries.push({ provider: 'rendered', exit: node.arguments[0] ? findActivation(node.arguments[0]) : null })
    }
    if (ts.isNewExpression(node) && node.expression.getText(tree) === 'WebLinksAddon') entries.push({ provider: 'addon', exit: null })
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return entries
}

it('keeps both OSC 8 and bounded rendered links on the same activation function', () => {
  expect(linkExits(source)).toEqual([
    { provider: 'native', exit: 'activateLink' },
    { provider: 'rendered', exit: 'activateLink' }
  ])
})

it('rejects an extra link provider that implements a separate action', () => {
  const mutated = source + "\nterminal.registerLinkProvider({ activate: anotherExit })"
  expect(linkExits(mutated)).toContainEqual({ provider: 'rendered', exit: 'anotherExit' })
  expect(linkExits(mutated)).toHaveLength(3)
})
