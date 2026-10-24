import { defineConfig } from 'vitest/config'
import source from './vitest.publication-continuity.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

const mutation = process.env.RECORDING_CONTINUITY_MUTANT
if (mutation && mutation !== 'original-revision') throw Error('Unknown recording continuity mutation')
export default defineConfig({ ...source, cacheDir: '.cache/recording-continuity', plugins: [...source.plugins!, {
  name: 'original-recording-continuity', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path)) return
    let code = original
    if (mutation && path === 'packages/connectors/src/durable-ingress.ts') {
      const before = '!sameRoomPublication(binding, current) || binding.agentSessionId !== target.agentSessionId'
      if (code.split(before).length !== 2) throw Error('Exact original recording authority must load once')
      code = code.replace(before, 'current.revision !== binding.revision || binding.agentSessionId !== target.agentSessionId')
    }
    if (process.env.RECORDING_CONTINUITY_LOADED) {
      const sha = (body: string) => createHash('sha256').update(body).digest('hex')
      appendFileSync(process.env.RECORDING_CONTINUITY_LOADED, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(code), ...(code !== original ? { mutation } : {}) }) + '\n')
    }
    return code === original ? undefined : code
  }
}], test: { ...source.test, include: ['packages/connectors/test/recording-continuity.test.ts'], testTimeout: 30_000 } })
