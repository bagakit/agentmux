import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

/** Resolve this fixture's first-party imports inside its exact checkout, never reused dependency links. */
export function candidateExport(root, specifier, browser = false) {
  assert.ok(specifier.startsWith('@agentmux/'), 'Only this fixture first-party imports are resolved here')
  const [, name, ...parts] = specifier.split('/'), directory = join(root, 'packages', name)
  const manifest = join(directory, 'package.json'), metadata = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.equal(metadata.name, '@agentmux/' + name)
  const entry = metadata.exports[parts.length ? './' + parts.join('/') : '.']
  const target = typeof entry === 'string' ? entry : browser && entry?.browser || entry?.import
  assert.equal(typeof target, 'string', 'An exact declared candidate export is required: ' + specifier)
  const file = realpathSync(join(directory, target))
  assert.ok(file.startsWith(root + sep), 'First-party export cannot resolve outside the candidate: ' + specifier)
  return { file, manifest }
}
