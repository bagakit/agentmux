import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import source from './a2a-resumed-inbox.config.mts'

const file = 'apps/host/src/spatial-presentation.ts'
const variants = {
  'drop-confirmed-content': ['content, quickMode: { status:', 'content: null, quickMode: { status:'],
  'borrow-another-home': ['zone.zoneId === homeZoneId(space.spaceId)', "zone.kind === 'home'"]
} as const
const mutation = process.env.MOTE_LOCATION_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Choose an exact location isolation mutation')
export default defineConfig({ ...source, cacheDir: resolve(source.root!, '.local/mote-location-isolation/cache', mutation ?? 'baseline'),
  plugins: [{ name: 'loaded-mote-location-owner', enforce: 'pre', transform(original, id) {
    if (relative(source.root!, id.split('?')[0]!) !== file) return
    let loaded = original
    if (mutation) {
      const [before, after] = variants[mutation]
      if (loaded.split(before).length !== 2) throw Error('One exact current location anchor is required')
      loaded = loaded.replace(before, after)
    }
    const trace = process.env.MOTE_LOCATION_LOADED
    if (trace) {
      const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
      const row = { path: file, rawSHA256: sha(readFileSync(resolve(source.root!, file), 'utf8')),
        originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: mutation ?? null }
      loaded = "import { appendFileSync as __locationLoaded } from 'node:fs'; __locationLoaded(" + JSON.stringify(trace) + ', ' +
        JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  } }, ...source.plugins!], test: { ...source.test, include: ['packages/core/test/mote-location-isolation.test.ts'], testTimeout: 60_000 } })
