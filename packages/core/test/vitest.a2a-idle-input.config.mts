import { idleInputMutations } from './fixtures/a2a-idle-input-proof.mjs'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../..'), packages = resolve(root, 'packages')
const inside = (parent: string, path: string) => {
  const name = relative(parent, path)
  return name !== '' && !name.startsWith('..') && !isAbsolute(name)
}
const identityRuntimeSource = '\0agentmux-identity-runtime-source'
let identityRuntime: Promise<string> | undefined
const mutations: Record<string, [string, string, string]> = idleInputMutations
export default defineConfig({ root, plugins: [{ name: 'original-workspace-source', enforce: 'pre', resolveId(id) {
  if (id === '@agentmux/identity/runtime-source') return identityRuntimeSource
  const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (!match) return
  const directory = resolve(packages, match[1]!)
  const entry = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']?.import
  if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
}, async load(id) {
  if (id !== identityRuntimeSource) return
  // This export is generated and has no src file; its original recipe rebuilds it from the identity sources.
  identityRuntime ??= import(pathToFileURL(resolve(packages, 'identity/scripts/runtime-bundle.mjs')).href)
    .then(recipe => recipe.bundleIdentityRuntime()).then(result => result.source)
  return `export const identityRuntimeSource = ${JSON.stringify(await identityRuntime)};\n`
}, transform(code, id) {
  const actual = id.split('?')[0]!
  if (!inside(packages, actual) || !/^[^/]+\/(?:src\/.+|package\.json)$/u.test(relative(packages, actual))) return
  const file = relative(root, actual)
  const mutation = process.env.AGENTMUX_IDLE_INPUT_MUTATION
  if (mutation && !mutations[mutation]) throw new Error('Unknown idle input mutation')
  const change = mutation && mutations[mutation], before = code
  if (change && file === change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Idle input mutation anchor is not unique: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.AGENTMUX_IDLE_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_IDLE_INPUT_LOADED,
    JSON.stringify({ file, originalSHA256: hash(before), sha256: hash(code), bytes: Buffer.byteLength(code), ...(before === code ? {} : { mutation }) }) + '\n')
  if (before !== code) return { code, map: null }
} }], test: { include: ['packages/core/test/a2a-idle-input.test.ts', 'packages/core/test/a2a-reference-budget.test.ts', 'packages/core/test/codex-idle-queue.test.ts', 'packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts', 'packages/core/test/provider-input-isolation.test.ts'], maxWorkers: 1, globalSetup: [], testTimeout: 20_000 } })
