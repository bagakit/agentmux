import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const inverse = process.env.COMPOSER_TOOLS_INVERSE ? JSON.parse(readFileSync(process.env.COMPOSER_TOOLS_INVERSE, 'utf8')) : undefined
export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.cache/composer-tools-first-presentation'),
  plugins: [{
    name: 'composer-tools-source-proof', enforce: 'pre',
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if ((!file.startsWith('apps/') && !file.startsWith('packages/')) || file.includes('/node_modules/')) return
      let source = original
      if (inverse?.file === file) {
        if (source.split(inverse.before).length !== 2) throw Error('Inverse must bind exactly one actual Tools site: ' + inverse.name)
        source = source.replace(inverse.before, inverse.after)
      }
      if (process.env.COMPOSER_TOOLS_LOADED) appendFileSync(process.env.COMPOSER_TOOLS_LOADED, JSON.stringify({
        file, sourceSHA256: createHash('sha256').update(original).digest('hex'),
        loadedSHA256: createHash('sha256').update(source).digest('hex'), ...(source === original ? {} : { mutation: inverse.name })
      }) + '\n')
      return source === original ? undefined : { code: source, map: null }
    }
  }],
  test: {
    ...base.test,
    include: ['apps/desktop/test/composer-tools-first-presentation.test.tsx'],
    exclude: [], passWithNoTests: false, testTimeout: 30000
  }
})
