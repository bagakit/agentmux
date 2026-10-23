import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

/** Follow this checkout's workspace exports and report every declaration read. */
export function candidateResolve(root, specifier, { browser = false, source = false, types = false, onManifest } = {}) {
  root = realpathSync(root)
  const [, name, ...parts] = specifier.split('/')
  const workspacePath = realpathSync(path.join(root, 'pnpm-workspace.yaml'))
  assert.ok(workspacePath.startsWith(root + path.sep), 'Candidate workspace escaped its checkout')
  const workspaceBytes = readFileSync(workspacePath)
  onManifest?.(workspacePath, workspaceBytes)
  const { packages } = parse(workspaceBytes.toString())
  assert.ok(Array.isArray(packages) && packages.length > 0 && packages.every(pattern => typeof pattern === 'string' && pattern.length > 0),
    'Candidate workspace must declare package patterns')
  const manifestPattern = pattern => path.posix.join(pattern, 'package.json')
  const manifests = globSync(packages.filter(pattern => !pattern.startsWith('!')).map(manifestPattern), {
    cwd: root, exclude: packages.filter(pattern => pattern.startsWith('!')).map(pattern => manifestPattern(pattern.slice(1)))
  })
  const matches = []
  for (const relative of new Set(manifests)) {
    const manifestPath = realpathSync(path.join(root, relative))
    assert.ok(manifestPath.startsWith(root + path.sep), 'Candidate manifest escaped its checkout: ' + specifier)
    const bytes = readFileSync(manifestPath)
    onManifest?.(manifestPath, bytes)
    const manifest = JSON.parse(bytes)
    if (manifest.name === '@agentmux/' + name) matches.push({ manifestPath, manifest })
  }
  assert.equal(matches.length, 1, 'Expected one declared candidate package: ' + specifier)
  const [{ manifestPath, manifest }] = matches, directory = path.dirname(manifestPath)
  const key = parts.length ? './' + parts.join('/') : '.'
  let entry = manifest.exports[key], wildcard
  if (!entry) {
    const pattern = Object.keys(manifest.exports).filter(value => value.includes('*'))
      .sort((a, b) => b.length - a.length).find(value => {
        const [before, after] = value.split('*'); return key.startsWith(before) && key.endsWith(after)
      })
    if (pattern) { const [before, after] = pattern.split('*'); wildcard = key.slice(before.length, key.length - after.length); entry = manifest.exports[pattern] }
  }
  let target = typeof entry === 'string' ? entry : types && entry?.types || (browser || name === 'client-ui') && entry?.browser || entry?.import
  assert.equal(typeof target, 'string', 'Missing declared candidate export: ' + specifier)
  if (wildcard !== undefined) target = target.replace('*', wildcard)
  if (source && target.startsWith('./dist/')) {
    const implementation = target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/(?:\.d\.ts|\.js)$/u, '.ts')
    // Generated-only exports retain the manifest's exact artifact in this checkout.
    if (existsSync(path.join(directory, implementation))) target = implementation
  }
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
