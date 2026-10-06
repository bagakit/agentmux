// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = ['ConversationImage', 'ConversationImageViewport'].map(name => readFileSync(join(packageRoot, `src/components/${name}.tsx`), 'utf8')).join('\n')
const classes = [...source.matchAll(/className="([^"]+)"/g)].flatMap(match => match[1]!.split(/\s+/))
const read = (path: string) => readFileSync(join(packageRoot, path), 'utf8')
function sharedCss(path: string): string {
  const css = read(path)
  return css.replace(/@import\s+'([^']+)'\s*;/g, (_all, specifier: string) => {
    expect(specifier.startsWith('.') && resolve(packageRoot, dirname(path), specifier).startsWith(resolve(packageRoot, 'src') + '/'), 'shared stylesheet imports must remain package-owned').toBe(true)
    return sharedCss(join(dirname(path), specifier))
  })
}

describe('public shared image style closure', () => {
  it('exports every class actually rendered by ConversationImage through its own stylesheet entry', () => {
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.exports['./styles.css']).toBe('./src/styles/index.css')
    expect(classes.length).toBeGreaterThan(0)
    const css = sharedCss(manifest.exports['./styles.css']).replace(/\/\*[\s\S]*?\*\//g, '')
    const styled = new Set([...css.matchAll(/\.([a-z][\w-]*)/g)].map(match => match[1]))
    expect(styled.size).toBeGreaterThan(0)
    for (const name of classes) expect(styled.has(name), `shared public CSS omits actual image class ${name}`).toBe(true)
  })
})
