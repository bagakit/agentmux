import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Follow declared exports in this checkout, including public subpath patterns. */
export function candidateResolve(root, specifier, browser = false) {
  const [, name, ...parts] = specifier.split('/'), directory = path.join(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
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
  const file = realpathSync(path.join(directory, target))
  assert.ok(file.startsWith(root + path.sep), 'Candidate export escaped its checkout: ' + specifier)
  return file
}
