// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(packageRoot, path), 'utf8')
const cssFiles = readdirSync(join(packageRoot, 'src/styles')).filter(file => file.endsWith('.css'))
describe('shared overlay style ownership', () => {
  it('keeps window layer definitions in the shared overlay owner while allowing local content order', () => {
    const declarations = cssFiles.flatMap(file => [...read(`src/styles/${file}`).matchAll(/--layer-[\w-]+\s*:\s*[^;]+;/g)].map(match => ({ file, declaration: match[0] })))
    expect(declarations).toHaveLength(5)
    expect(new Set(declarations.map(item => item.file))).toEqual(new Set(['overlays.css']))
    for (const name of ['window-chrome', 'tooltip', 'popover', 'service', 'dialog'])
      expect(declarations.some(item => item.declaration.startsWith(`--layer-${name}:`))).toBe(true)
    const entry = read('src/styles/index.css')
    expect(entry).toContain("@import './overlays.css'")
  })

  it('keeps actual shared floating consumers on the common ranks and an opaque authored material', () => {
    const completion = read('src/components/ComposerCompletionEditor.tsx')
    const reactions = read('src/components/ConversationReactionActions.tsx')
    expect(completion).toContain('className="composer-completion-popover"')
    expect(reactions).toContain('className="conversation-reactions__hint"')
    expect(read('src/styles/composer.css').match(/\.composer-completion-popover\s*\{([^}]+)\}/)?.[1]).toContain('z-index: var(--layer-popover)')
    expect(read('src/styles/conversation-reactions.css').match(/\.conversation-reactions__hint\s*\{([^}]+)\}/)?.[1]).toContain('z-index: var(--layer-tooltip)')
    expect(read('src/styles/palette.css')).toContain('--overlay-surface: var(--surface-2);')
    expect(cssFiles.flatMap(file => [...read(`src/styles/${file}`).matchAll(/--z-menu/g)])).toHaveLength(0)
  })
})
