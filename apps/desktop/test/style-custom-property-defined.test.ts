import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
// Every stylesheet the shipped surfaces can load, and every script that can define a property at run time.
const SOURCE_ROOTS = ['apps/desktop/src', 'packages/client-ui/src', 'apps/mobile/src']

function walk(directory: string, accept: (path: string) => boolean): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : walk(path, accept)
    return accept(path) ? [path] : []
  })
}
const files = SOURCE_ROOTS.flatMap(base => walk(join(root, base), path => /\.(css|tsx?|mts)$/u.test(path) && !/\.(test|spec)\./u.test(path)))
const text = new Map(files.map(path => [path, readFileSync(path, 'utf8')]))
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '')

/** A custom property is defined by a declaration in a stylesheet or by any script that names it as a property. */
function definedProperties(): Set<string> {
  const defined = new Set<string>()
  for (const [path, source] of text) {
    const body = path.endsWith('.css') ? stripComments(source) : source
    if (path.endsWith('.css')) for (const match of body.matchAll(/(?:^|[{;\s])(--[a-z0-9-]+)\s*:/giu)) defined.add(match[1]!)
    // Inline style objects, setProperty calls and generated theme tables: any quoted property name.
    else for (const match of body.matchAll(/['"`](--[a-z0-9-]+)['"`]/giu)) defined.add(match[1]!)
    // A theme injector may build names from a prefix (`--${name}`); those prefixes cover every suffix.
    if (!path.endsWith('.css')) for (const match of body.matchAll(/['"`](--[a-z0-9-]+-)\$\{/giu)) defined.add(match[1]! + '*')
  }
  return defined
}

function usedProperties(): Array<{ file: string; property: string; line: number }> {
  const used: Array<{ file: string; property: string; line: number }> = []
  for (const [path, source] of text) {
    if (!path.endsWith('.css')) continue
    const body = stripComments(source)
    for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/giu)) {
      // A var() with its own fallback states what happens when the property is absent; only bare uses must resolve.
      if (match[2] === ',') continue
      used.push({ file: relative(root, path), property: match[1]!, line: body.slice(0, match.index).split('\n').length })
    }
  }
  return used
}

it('every bare var() in a shipped stylesheet names a property that a stylesheet or script defines', () => {
  const defined = definedProperties(), used = usedProperties()
  // The scan must see the real stylesheets, or an empty result would pass for the wrong reason.
  expect(used.length).toBeGreaterThan(1000)
  expect(defined.has('--green') && defined.has('--surface-2') && defined.has('--elev-3')).toBe(true)
  // Radix sets these on its own popper content at run time; they are part of its documented styling contract.
  const library = (property: string) => /^--radix-[a-z-]+-(available-height|available-width|trigger-width|trigger-height|transform-origin)$/u.test(property)
  const covered = (property: string) => library(property) || defined.has(property) || [...defined].some(entry => entry.endsWith('*') && property.startsWith(entry.slice(0, -1)))
  const missing = used.filter(entry => !covered(entry.property)).map(entry => `${entry.file}:${entry.line} ${entry.property}`)
  expect(missing).toEqual([])
})
