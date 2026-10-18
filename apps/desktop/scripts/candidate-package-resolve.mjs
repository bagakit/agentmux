import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Follow declared exports in this checkout, including public subpath patterns. */
export function candidateResolve(root, specifier, { browser = false, source = false, onManifest } = {}) {
  root = realpathSync(root)
  const [, name, ...parts] = specifier.split('/'), directory = path.join(root, 'packages', name)
  const manifestPath = realpathSync(path.join(directory, 'package.json'))
  assert.ok(manifestPath.startsWith(root + path.sep), 'Candidate manifest escaped its checkout: ' + specifier)
  const bytes = readFileSync(manifestPath)
  onManifest?.(manifestPath, bytes)
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.name, '@agentmux/' + name)
  const key = parts.length ? './' + parts.join('/') : '.'
  let entry = manifest.exports[key], wildcard
  if (!entry) {
    const pattern = Object.keys(manifest.exports).filter(value => value.includes('*'))
      .sort((a, b) => b.length - a.length).find(value => {
        const [before, after] = value.split('*'); return key.startsWith(before) && key.endsWith(after)
      })
    if (pattern) { const [before, after] = pattern.split('*'); wildcard = key.slice(before.length, key.length - after.length); entry = manifest.exports[pattern] }
  }
  let target = typeof entry === 'string' ? entry : (browser || name === 'client-ui') && entry?.browser || entry?.import
  assert.equal(typeof target, 'string', 'Missing declared candidate export: ' + specifier)
  if (wildcard !== undefined) target = target.replace('*', wildcard)
  if (source && target.startsWith('./dist/')) target = target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts')
  const file = realpathSync(path.join(directory, target))
  assert.ok(file.startsWith(root + path.sep), 'Candidate export escaped its checkout: ' + specifier)
  return file
}

/** Vite's CSS importer uses aliases, independently of user resolveId plugins. */
export function candidateAlias(root, options) {
  return { find: /^@agentmux\//u, replacement: '@agentmux/',
    customResolver: specifier => candidateResolve(root, specifier, options) }
}

/** Ordinary dependencies may be shared; first-party source belongs to this checkout. */
export function candidateModule(root, file) {
  const actual = realpathSync(file)
  assert.ok(actual.startsWith(realpathSync(root) + path.sep) || actual.includes(path.sep + 'node_modules' + path.sep),
    'First-party build input escaped its checkout: ' + file)
  return actual
}
