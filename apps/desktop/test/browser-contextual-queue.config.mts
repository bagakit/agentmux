import { defineConfig } from 'vitest/config'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import owning from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), core = resolve(root, 'packages/core')
const manifest = JSON.parse(readFileSync(resolve(core, 'package.json'), 'utf8'))
const alias = Object.entries(manifest.exports).flatMap(([key, spec]) => {
  const target = (spec as { import?: string }).import
  if (typeof target !== 'string' || !target.startsWith('./dist/')) return []
  const source = resolve(core, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
  return existsSync(source) ? [{ find: key === '.' ? /^@agentmux\/core$/u : '@agentmux/core' + key.slice(1), replacement: source }] : []
})
// This slice loads the current Core sources directly; it never qualifies an older dist.
export default defineConfig({ ...owning, root, resolve: { ...owning.resolve, alias }, test: { ...owning.test, globalSetup: [],
  include: ['apps/desktop/test/browser-contextual-queue.test.ts'], environment: 'happy-dom',
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
