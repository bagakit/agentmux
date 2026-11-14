import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const inverse = process.env.TERMINAL_OWNER_INVERSE ? JSON.parse(readFileSync(process.env.TERMINAL_OWNER_INVERSE, 'utf8')) : undefined
export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.cache/terminal-owner-retention'),
  plugins: [{
    name: 'terminal-owner-source-proof', enforce: 'pre',
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if ((!file.startsWith('apps/') && !file.startsWith('packages/')) || file.includes('/node_modules/')) return
      let source = original
      if (inverse?.file === file) {
        if (source.split(inverse.before).length !== 2) throw Error('Inverse must bind exactly one terminal owner site: ' + inverse.name)
        source = source.replace(inverse.before, inverse.after)
      }
      if (process.env.TERMINAL_OWNER_LOADED) appendFileSync(process.env.TERMINAL_OWNER_LOADED, JSON.stringify({
        file, sourceSHA256: createHash('sha256').update(original).digest('hex'),
        loadedSHA256: createHash('sha256').update(source).digest('hex'), ...(source === original ? {} : { mutation: inverse.name })
      }) + '\n')
      return source === original ? undefined : { code: source, map: null }
    }
  }],
  test: {
    ...base.test,
    include: ['apps/desktop/test/terminal-webgl-visibility.test.tsx'],
    exclude: [],
    passWithNoTests: false,
    testNamePattern: process.env.TERMINAL_OWNER_PATTERN ??
      '\\[terminal-owner-retention\\]|releases only the GPU when hidden|records cleanup spans while hide|keeps retiring xterm cleanup on the original Run|refresh waits for accepted hidden bytes|maps the public retained selection range through actual document reflow: same columns',
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    testTimeout: 30000
  }
})
