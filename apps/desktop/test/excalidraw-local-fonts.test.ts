import { fixtureFileUrl as _hygiene_fixtureFileUrl } from "../scripts/lib/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { transformWithEsbuild, type UserConfig } from 'vite'
import { EXCALIDRAW_LOCAL_FONTS_VERSION, localizeExcalidrawFontUrls } from '../scripts/excalidraw-local-fonts'
import { fileDiagramAssets } from '../scripts/file-diagram-assets'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(dirname(require.resolve('@excalidraw/excalidraw'))))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild') as { build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }> }

describe('bundled official Excalidraw fonts', () => {
  it('removes only the unconditional hosted fallback from both pinned official distributions', async () => {
    expect(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version).toBe(EXCALIDRAW_LOCAL_FONTS_VERSION)
    for (const distribution of ['dev', 'prod']) {
      const directory = join(packageRoot, 'dist', distribution)
      const sources = readdirSync(directory).filter(file => file.endsWith('.js')).map(file => ({ id: join(directory, file), code: readFileSync(join(directory, file), 'utf8') })).filter(source => source.code.includes('ASSETS_FALLBACK_URL'))
      expect(sources).toHaveLength(1)
      const { id, code } = sources[0]!
      const transformed = localizeExcalidrawFontUrls(code, id)!
      expect(transformed).not.toBe(code)
      expect(transformed).not.toMatch(/\.push\(\s*new URL\([^)]*\.ASSETS_FALLBACK_URL/)
      await expect(transformWithEsbuild(transformed, id, { target: 'esnext' })).resolves.toBeDefined()
      if (distribution === 'dev') {
        // Execute the actual official URL method, with only its base normalizer
        // and the browser global supplied by this fixture.
        const method = transformed.slice(transformed.indexOf('static createUrls(uri)'), transformed.indexOf('static getFormat(url)'))
        const urls = new Function('window', 'LOCAL_FONT_PROTOCOL', `return (class { ${method} static normalizeBaseUrl(value) { return value } }).createUrls('./fonts/Excalifont/local.woff2')`)(
          { EXCALIDRAW_ASSET_PATH: _hygiene_fixtureFileUrl("bundled/excalidraw-assets/") }, 'local:'
        ) as URL[]
        expect(urls.map(url => url.href)).toEqual([_hygiene_fixtureFileUrl("bundled/excalidraw-assets/fonts/Excalifont/local.woff2")])
      }
    }
  })

  it('leaves unrelated modules alone and rejects unexpected official distribution changes', () => {
    const code = 'urls.push(new URL(uri, Fonts.ASSETS_FALLBACK_URL))'
    expect(localizeExcalidrawFontUrls(code, _hygiene_fixturePath("other/package/index.js"))).toBeUndefined()
    expect(() => localizeExcalidrawFontUrls('ASSETS_FALLBACK_URL', join(packageRoot, 'dist/prod/changed.js'))).toThrow(/distribution changed/)
  })

  it('applies the same official change through the product Vite transform and actual dev optimizer', async () => {
    const plugin = fileDiagramAssets(resolve(import.meta.dirname, '..'))
    const directory = join(packageRoot, 'dist/prod')
    const id = readdirSync(directory).map(file => join(directory, file)).find(file => file.endsWith('.js') && readFileSync(file, 'utf8').includes('ASSETS_FALLBACK_URL'))!
    const code = readFileSync(id, 'utf8')
    const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler
    const result = await (transform as ((code: string, id: string) => string | undefined) | undefined)?.(code, id)
    expect(result).toBe(localizeExcalidrawFontUrls(code, id))
    const config = (plugin.config as () => Pick<UserConfig, 'optimizeDeps'>)()
    const bundled = await build({ entryPoints: [id], bundle: false, write: false, logLevel: 'silent', plugins: config.optimizeDeps!.esbuildOptions!.plugins })
    expect(bundled.outputFiles![0]!.text).not.toMatch(/\.push\(\s*new URL\([^)]*\.ASSETS_FALLBACK_URL/)
  })
})
