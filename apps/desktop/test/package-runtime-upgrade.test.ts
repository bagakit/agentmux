import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import ts from 'typescript'

const source = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = parsed.statements.filter(ts.isFunctionDeclaration)
const install = functions.find((node) => node.name?.text === 'installApplication')!
expect(install?.body).toBeDefined()

function calls(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

it('preflights the exact selected Runtime before quit, and confirms handoff after cutover before the new GUI', () => {
  const prepare = calls(install, 'prepareRuntimeUpgrade')
  const finish = calls(install, 'finishRuntimeUpgrade')
  const quits = calls(install, 'quit')
  const renames = calls(install, 'rename')
  const cutover = renames.find((node) => node.arguments[0]?.getText(parsed) === 'next' && node.arguments[1]?.getText(parsed) === 'destination')
  const launches = calls(install, 'launch')
  expect(prepare).toHaveLength(2); expect(finish).toHaveLength(1); expect(quits).toHaveLength(1)
  expect(cutover).toBeDefined(); expect(launches).toHaveLength(5)
  expect(prepare[0]!.getStart(parsed)).toBeLessThan(quits[0]!.getStart(parsed))
  expect(prepare[1]!.getStart(parsed)).toBeGreaterThan(quits[0]!.getStart(parsed))
  expect(prepare[1]!.getStart(parsed)).toBeLessThan(cutover!.getStart(parsed))
  expect(finish[0]!.getStart(parsed)).toBeGreaterThan(cutover!.getStart(parsed))
  const newLaunch = launches.find(node => ts.isAwaitExpression(node.parent) && ts.isBinaryExpression(node.parent.parent) && node.parent.parent.left.getText(parsed) === 'relaunched')
  expect(newLaunch).toBeDefined()
  expect(finish[0]!.getStart(parsed)).toBeLessThan(newLaunch!.getStart(parsed))
})

it('restores the old App only on a positive old-protocol result, and never launches it on an unknown handoff', () => {
  const branches: ts.IfStatement[] = []
  const visit = (node: ts.Node): void => { if (ts.isIfStatement(node)) branches.push(node); ts.forEachChild(node, visit) }
  visit(install)
  const old = branches.find((node) => node.expression.getText(parsed) === "handoff.status === 'old-confirmed'")
  expect(old).toBeDefined()
  const oldRenames = calls(old!.thenStatement, 'rename')
  expect(oldRenames.map((node) => node.arguments.map((arg) => arg.getText(parsed)))).toEqual([
    ['destination', 'next'], ['previousInstall', 'destination']
  ])
  const oldLaunches = calls(old!.thenStatement, 'launch')
  expect(oldLaunches).toHaveLength(1)
  expect(oldLaunches[0]!.getStart(parsed)).toBeGreaterThan(oldRenames[1]!.getStart(parsed))
  const throws: ts.ThrowStatement[] = []
  const collectThrows = (node: ts.Node): void => { if (ts.isThrowStatement(node)) throws.push(node); ts.forEachChild(node, collectThrows) }
  collectThrows(old!.thenStatement)
  expect(throws).toHaveLength(1)
  const upgraded = calls(install, 'assert').find((node) => node.arguments[0]?.getText(parsed) === "handoff.status === 'upgraded'")
  expect(upgraded).toBeDefined()
  expect(upgraded!.getStart(parsed)).toBeGreaterThan(old!.getEnd())
  const newLaunch = calls(install, 'launch').find(node => ts.isAwaitExpression(node.parent) && ts.isBinaryExpression(node.parent.parent) && node.parent.parent.left.getText(parsed) === 'relaunched')
  expect(newLaunch).toBeDefined()
  expect(upgraded!.getStart(parsed)).toBeLessThan(newLaunch!.getStart(parsed))
})

it('cleans the owned inspection SDKs even when cutover, handoff or GUI launch fails', () => {
  const tryBlocks: ts.TryStatement[] = []
  const visit = (node: ts.Node): void => { if (ts.isTryStatement(node)) tryBlocks.push(node); ts.forEachChild(node, visit) }
  visit(install)
  const lifecycle = tryBlocks.find((node) => node.finallyBlock && calls(node.finallyBlock, 'closeRuntimeUpgrade').length === 2)
  expect(lifecycle).toBeDefined()
  expect(calls(lifecycle!.tryBlock, 'finishRuntimeUpgrade')).toHaveLength(1)
  expect(calls(lifecycle!.tryBlock, 'launch')).toHaveLength(5)
})

it('reports the actual UI and Native results independently to the product caller', async () => {
  const { reportInstallTransaction } = await import('../scripts/package-macos.mjs')
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true }) as typeof process.stdout.write
  try {
    reportInstallTransaction({ intent: 'ui-only', ui: { status: 'committed', path: '/private/candidate.app' },
      native: { status: 'deferred', reason: 'Original Runtime retained' } })
    expect(chunks).toHaveLength(2)
    const result = JSON.parse(chunks[0]!.trim().slice('install_transaction='.length))
    expect(result).toEqual({ intent: 'ui-only', ui: { status: 'committed', path: '/private/candidate.app' },
      native: { status: 'deferred', reason: 'Original Runtime retained' } })
    expect(chunks[1]).toContain('Native update deferred: Original Runtime retained')
    expect(() => reportInstallTransaction({ ui: { status: 'committed' } })).toThrow('both component outcomes')
  } finally { process.stdout.write = original }
})
