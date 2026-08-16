import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string): string => readFileSync(join(desktopRoot, relative), 'utf8')

describe('standalone component gallery boundary', () => {
  it('has a dedicated HTML entry and renderer mount', () => {
    const html = read('src/renderer/gallery.html')
    const entry = read('src/renderer/src/gallery-main.tsx')
    expect(html).toContain('src/gallery-main.tsx')
    expect(entry).toContain('<WorkflowComponentGallery />')
    expect(entry).toContain("./styles/index.css")
  })

  it('keeps the gallery entry free of Desktop Store, Core and Runtime startup imports', () => {
    const entry = read('src/renderer/src/gallery-main.tsx')
    expect(entry).not.toContain("'./App'")
    expect(entry).not.toContain("'./store'")
    expect(entry).not.toContain("'./lib/api'")
    expect(entry).not.toContain("'@agentmux/core'")
  })

  it('pins the prefixed build to the dedicated Vite config and script', () => {
    const config = read('vite.gallery.config.ts')
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
    expect(config).toContain("base: '/agentmux-gallery/'")
    expect(config).toContain('gallery.html')
    expect(packageJson.scripts?.['build:gallery']).toBe('vite build --config vite.gallery.config.ts')
  })
})
