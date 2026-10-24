import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { transformResumedInboxSource } from './fixtures/a2a-resumed-inbox/mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_RESUMED_INBOX_MUTATION
export default defineConfig({ root, plugins: [{ name: 'a2a-resumed-inbox-source', enforce: 'pre', resolveId(id) {
  // This export is generated runtime text, not a TypeScript source module.
  if (id === '@agentmux/identity/runtime-source') return resolve(root, 'packages/identity/dist/runtime-source.js')
  const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (!match) return
  const directory = resolve(root, 'packages', match[1]!), manifestPath = resolve(directory, 'package.json')
  const manifest = readFileSync(manifestPath, 'utf8')
  const entry = JSON.parse(manifest).exports?.[match[2] ? '.' + match[2] : '.']?.import
  if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
}, transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/') || path.includes('/node_modules/') || !path.endsWith('.ts')) return
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const code = transformResumedInboxSource(source, path, mutation)
  if (process.env.AGENTMUX_RESUMED_INBOX_LOADED) appendFileSync(process.env.AGENTMUX_RESUMED_INBOX_LOADED,
    JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), ...(code === source ? {} : { mutation }) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/a2a-resumed-inbox.test.ts', 'packages/core/test/a2a-resumed-inbox-runtime.test.ts'],
  globalSetup: [], maxWorkers: 1, testTimeout: 30_000, hookTimeout: 15_000, passWithNoTests: false } })
