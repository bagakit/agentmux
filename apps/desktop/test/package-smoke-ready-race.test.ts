import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { expect, it } from 'vitest'

const source = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = ast.statements.filter(ts.isFunctionDeclaration)
const wait = functions.find(node => node.name?.text === 'waitForPath')!
const smoke = functions.find(node => node.name?.text === 'verifyLaunchServices')!
function calls(node: ts.Node, name: string): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) return true
  return ts.forEachChild(node, child => calls(child, name) || undefined) ?? false
}

it.each(['microtask', 'next-turn'])('consumes the ready receipt published during the %s exit observation', async delay => {
  expect(calls(smoke, 'waitForPath')).toBe(true)
  let ready = false
  const invoke = new Function('pathExists', `return (${wait.getText(ast)})`)(async () => ready)
  const alive = async () => {
    if (delay === 'microtask') await Promise.resolve()
    else await new Promise<void>(resolve => setImmediate(resolve))
    ready = true
    return false
  }
  expect(await invoke(_hygiene_fixturePath("private/ready"), Date.now() + 10_000, alive)).toBe(true)
})

it.each([
  { name: 'ready already present', initial: true, duringExit: false, elapsed: 0, expected: true },
  { name: 'exit without receipt', initial: false, duringExit: false, elapsed: 0, expected: false },
  { name: 'receipt after deadline', initial: false, duringExit: true, elapsed: 11, expected: false },
  { name: 'initial read after deadline', initial: true, duringExit: false, elapsed: 11, expected: false }
])('$name respects receipt and deadline', async ({ initial, duringExit, elapsed, expected }) => {
  let now = 0, ready = initial
  const invoke = new Function('pathExists', 'Date', `return (${wait.getText(ast)})`)(
    async () => { if (initial) now = elapsed; return ready }, { now: () => now }
  )
  expect(await invoke(_hygiene_fixturePath("private/ready"), 10, async () => {
    await Promise.resolve(); now = elapsed; ready = duringExit; return false
  })).toBe(expected)
})
