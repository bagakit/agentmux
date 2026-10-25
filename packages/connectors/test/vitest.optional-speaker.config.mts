import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import native from './vitest.channel-history.config.mts'

const mutant = process.env.OPTIONAL_SPEAKER_MUTANT
if (mutant && mutant !== 'wait-for-profile') throw Error('Unknown optional speaker mutation')
export default defineConfig({ ...native, cacheDir: '.cache/optional-speaker',
  plugins: [...native.plugins!, { name: 'optional-speaker-loaded-consumer', enforce: 'pre',
    transform(original, id) {
      const path = relative(native.root!, id.split('?')[0]!)
      if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.ts$/u.test(path)) return
      let code = original
      if (mutant && path === 'packages/connectors/src/publication-host.ts') {
        const before = 'return await this.until(reading, AbortSignal.any([signal, AbortSignal.timeout(OPTIONAL_DISPLAY_WAIT_MS)]))'
        if (code.split(before).length !== 2) throw Error('Original optional speaker observation must load once')
        code = code.replace(before, 'return await this.until(reading, signal)')
      }
      if (process.env.OPTIONAL_SPEAKER_LOADED) {
        const hash = (value: string) => createHash('sha256').update(value).digest('hex')
        appendFileSync(process.env.OPTIONAL_SPEAKER_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation: mutant } : {}) }) + '\n')
      }
      if (code !== original) return code
    }
  }], test: { ...native.test, include: ['packages/connectors/test/a2a-publication-consumer.test.ts'], testNamePattern: /^optional speaker observation/u, testTimeout: 30_000 } })
