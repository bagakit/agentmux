import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './connection-owner-consumer.config.mts'

const root = original.root!
const mutant = process.env.MOTE_AVATAR_MUTANT
if (mutant && mutant !== 'object-identity-disconnect') throw Error('Unknown original avatar-read mutation')
export default defineConfig({ ...original, plugins: [{ name: 'original-avatar-reader', enforce: 'pre',
  resolveId(source) { if (source.startsWith('@agentmux/host/')) return resolve(root, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts') },
  transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(apps\/host\/src|apps\/desktop\/src\/main\/mote-avatar-writer)/u.test(path)) return
    let loaded = source
    if (mutant && path === 'apps/host/src/mote-avatar-read.ts') {
      const before = 'topics.avatarTargetDirectory('
      if (source.split(before).length !== 3) throw Error('The two exact resource checks must be present')
      loaded = source.replaceAll(before, 'topics.avatarMoteDirectory(')
    }
    if (process.env.MOTE_AVATAR_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA256: sha(loaded), ...(loaded !== source ? { mutation: mutant } : {}) }
      return { code: "import { appendFileSync as __avatarReadLoad } from 'node:fs'; __avatarReadLoad(" + JSON.stringify(process.env.MOTE_AVATAR_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (loaded !== source) return loaded
  }
}, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/mote-avatar-read-consumer.test.ts'], testTimeout: 25_000 } })
