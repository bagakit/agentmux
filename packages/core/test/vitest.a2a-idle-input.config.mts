import { idleInputMutations } from './fixtures/a2a-idle-input-proof.mjs'
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleIdentityRuntime } from '../../identity/scripts/runtime-bundle.mjs'
const root = resolve(import.meta.dirname, '../../..')
const identitySourcePath = resolve(root, 'packages/identity/dist/runtime-source.js')
const identityArtifact = await import(pathToFileURL(identitySourcePath).href)
// This generated export has no src/runtime-source.ts. Qualify the original artifact
// against its non-writing build recipe before reusing it in the source consumer graph.
if (identityArtifact.identityRuntimeSource !== (await bundleIdentityRuntime()).source)
  throw new Error('The identity runtime source artifact does not match its original build recipe')
const mutations: Record<string, [string, string, string]> = idleInputMutations
export default defineConfig({ root, plugins: [{ name: 'original-workspace-source', enforce: 'pre', resolveId(id) {
  if (id === '@agentmux/identity/runtime-source') return identitySourcePath
  const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (!match) return
  const directory = resolve(root, 'packages', match[1]!)
  const entry = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']?.import
  if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
}, transform(code, id) {
  const file = relative(resolve(root, 'packages/core/src'), id.split('?')[0]!)
  if (file.startsWith('..') || !file.endsWith('.ts')) return
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
