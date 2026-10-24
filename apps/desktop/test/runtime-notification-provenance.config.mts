import { defineConfig } from 'vitest/config'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import source from './vitest.notification-diagnostics.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const aliases = [resolve(root, 'apps/host'), ...readdirSync(resolve(root, 'packages')).map(name => resolve(root, 'packages', name))].flatMap(directory => {
  if (!existsSync(resolve(directory, 'package.json'))) return []
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return Object.entries<any>(pkg.exports ?? {}).flatMap(([key, entry]) => {
    const target = typeof entry === 'string' ? entry : entry.types ?? entry.import
    if (typeof target !== 'string' || !target.startsWith('./dist/')) return []
    const path = resolve(directory, target.replace(/^\.\/dist\/(src\/)?/u, './src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
    return existsSync(path) ? [{ find: pkg.name + (key === '.' ? '' : key.slice(1)), replacement: path }] : []
  })
}).sort((a, b) => b.find.length - a.find.length).map(alias => ({ ...alias,
  find: new RegExp('^' + alias.find.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$') }))
const inherited = source.resolve?.alias
export default defineConfig({ ...source, resolve: { ...source.resolve,
  alias: [...aliases, ...(Array.isArray(inherited) ? inherited : Object.entries(inherited ?? {}).map(([find, replacement]) => ({ find, replacement })))] },
  test: { ...source.test,
  include: ['apps/desktop/test/notification-diagnostics.test.tsx'],
  testNamePattern: 'runtime lifecycle provenance:', testTimeout: 60000, hookTimeout: 60000 } })
