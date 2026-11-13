import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'

/** Ship upstream decoder licenses with the exact local assets used by the reader. */
export function editorExtensionNotices(): Plugin {
  const require = createRequire(import.meta.url)
  const djvu = dirname(require.resolve('djvu-rs'))
  const zip = dirname(require.resolve('@zip.js/zip.js'))
  const fflate = dirname(require.resolve('fflate/package.json'))
  const pdf = dirname(require.resolve('pdfjs-dist/package.json'))
  const notices = [
    ['djvu-rs/LICENSE', join(djvu, 'LICENSE')],
    ['djvu-rs/THIRD_PARTY_NOTICES', join(djvu, 'THIRD_PARTY_NOTICES')],
    ['zip.js/LICENSE', join(zip, 'LICENSE')],
    ['fflate/LICENSE', join(fflate, 'LICENSE')],
    ['pdfjs/LICENSE', join(pdf, 'LICENSE')],
    ['foliate-js/LICENSE', resolve(dirname(require.resolve('@agentmux/editor-extensions/package.json')), 'src/books/vendor/foliate/LICENSE')]
  ] as const
  return { name: 'agentmux-editor-extension-notices', writeBundle(options) {
    if (!options.dir) throw new Error('Editor extension output directory is required')
    for (const [name, source] of notices) {
      const target = join(options.dir, 'licenses/editor-extensions', name)
      mkdirSync(dirname(target), { recursive: true }); cpSync(source, target)
    }
  } }
}
