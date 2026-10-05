import { fixturePath as _hygiene_fixturePath, fixturePsBirth as _hygiene_fixturePsBirth } from "../scripts/lib/fixture-values.mjs"
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

const source = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const declarations: ts.VariableDeclaration[] = [], calls: ts.CallExpression[] = []
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ownedSemanticHostPids') declarations.push(node)
  if (ts.isCallExpression(node)) calls.push(node)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(declarations.length, 1, 'Use the unique production private Host cleanup query')
const executable = _hygiene_fixturePath("private/fixture/AgentMux.app/Contents/MacOS/AgentMux")
const command = ("" + (executable) + (" " + _hygiene_fixturePath("private/fixture/agentmux-host.js") + " --store " + _hygiene_fixturePath("private/fixture/sessions.json")))
const birth = _hygiene_fixturePsBirth(24580800000), uid = process.getuid!(), pid = 83
const identity = { uid, pid, ppid: 70, birth }
const mode = { ...identity, mode: 'node', executable }
const observed = `${uid} ${pid} 70 ${birth} ${command}\n`

function query(current: typeof identity | null = identity, node: Partial<typeof mode> | null = mode,
  options: { ps?: string; owners?: Map<number, string>; unavailable?: boolean } = {}) {
  const run = vi.fn(async () => ({ stdout: options.ps ?? observed }))
  const scope = vi.fn(async () => {
    if (options.unavailable) throw new Error('original OS snapshot unavailable')
    return { ownershipObservation: { identities: new Map(current ? [[pid, current]] : []) }, nodeModes: node ? [node] : [] }
  })
  return new Function('run', 'scopedProcesses', 'canonicalAppPath', 'semanticHostCommand', 'semanticHostOwners', 'executable', 'assert', 'process',
    `return (${declarations[0]!.initializer!.getText(ast)})`)(run, scope, _hygiene_fixturePath("private/fixture/AgentMux.app"), command,
    options.owners ?? new Map(), executable, assert, process) as () => Promise<number[]>
}

async function outcome(invoke: () => Promise<number[]>) {
  try { return { value: await invoke() } }
  catch (error) { return { error } }
}

it('the public package and DMG path consumes this exact private cleanup query', () => {
  expect(calls.filter(call => ts.isIdentifier(call.expression) && call.expression.text === 'cleanupProcessScope' &&
    call.arguments[0]?.getText(ast) === "'semantic-host'" && call.arguments[1]?.getText(ast) === 'ownedSemanticHostPids')).toHaveLength(1)
  for (const name of ['verifyLaunchServices', 'verifyDmg']) {
    expect(calls.some(call => ts.isIdentifier(call.expression) && call.expression.text === name)).toBe(true)
  }
})
it('returns the original private Host only with a bound current Node identity', async () => {
  expect(await outcome(query())).toEqual({ value: [pid] })
})
it.each([null, { pid, mode: 'unknown' }])('settles later OS absence even when mode is %j', async missingMode => {
  expect(await outcome(query(null, missingMode))).toEqual({ value: [] })
})
it('uses the freshly bound parent after the original private Host is reparented', async () => {
  expect(await outcome(query({ ...identity, ppid: 1 }, { ...mode, ppid: 1 }))).toEqual({ value: [pid] })
})
it.each([
  ['unknown mode', identity, { ...mode, mode: 'unknown' }],
  ['missing mode', identity, null],
  ['other UID', { ...identity, uid: uid + 1 }, { ...mode, uid: uid + 1 }],
  ['reused PID', { ...identity, birth: _hygiene_fixturePsBirth(24580801000) }, { ...mode, birth: _hygiene_fixturePsBirth(24580801000) }],
  ['other executable', identity, { ...mode, executable: _hygiene_fixturePath("private/other") }],
  ['stale parent binding', { ...identity, ppid: 1 }, mode],
] as const)('protects a still-present %s', async (_name, current, node) => {
  expect((await outcome(query(current, node))).error).toBeInstanceOf(Error)
})
it('retains prior private Host birth and refuses PID reuse', async () => {
  expect((await outcome(query(identity, mode, { owners: new Map([[pid, 'earlier birth']]) }))).error).toMatchObject({message:expect.stringContaining('reused')})
})
it('OS query failure is unknown and never an exit fact', async () => {
  expect((await outcome(query(identity, mode, { unavailable: true }))).error).toMatchObject({message:'original OS snapshot unavailable'})
})
it('does not select another private command or an arbitrary Node worker', async () => {
  expect(await outcome(query(identity, mode, { ps: observed.replace(command, executable + ' unrelated.js') }))).toEqual({value:[]})
})
