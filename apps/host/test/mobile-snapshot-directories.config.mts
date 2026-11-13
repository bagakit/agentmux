import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../../mobile/test/connection-link.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.AGENTMUX_SNAPSHOT_DIRECTORY_MUTANT
const variants = {
  'missing-config-owner': { file: 'apps/host/src/snapshot-observation.ts', before: "if (wanted('projects')) {", after: 'if (false) {' },
  'generic-owner-again': { file: 'packages/core/src/public-rpc-service.ts', before: "if ((source === 'projects' || source === 'executors') && Object.hasOwn(extra, source)) return", after: 'if (false) return' },
  'runtime-per-project': { file: 'apps/host/src/snapshot-observation.ts', before: '[...new Set(projects.map(project => project.hostId))]', after: 'projects.map(project => project.hostId)' }
} as const
if (mutant && !(mutant in variants)) throw Error('Unknown snapshot directory mutant')
export default { ...base, cacheDir: resolve(root, '.tmp/snapshot-directories', mutant ?? 'normal'),
  plugins: [...(base.plugins ?? []), { name: 'source-snapshot-directories', enforce: 'pre' as const, transform(original: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/host/src/snapshot-observation.ts', 'packages/core/src/public-rpc-service.ts'].includes(file)) return
    let loaded = original
    const variant = mutant ? variants[mutant as keyof typeof variants] : undefined
    if (variant?.file === file) { if (original.split(variant.before).length !== 2) throw Error('Snapshot mutant anchor must occur once'); loaded = original.replace(variant.before, variant.after) }
    const report = process.env.AGENTMUX_SNAPSHOT_DIRECTORY_LOADED
    if (report) { const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      appendFileSync(report, JSON.stringify({ file, sourceSHA256: hash(original), loadedSHA256: hash(loaded), mutation: variant?.file === file ? mutant : null }) + '\n') }
    return loaded === original ? undefined : { code: loaded, map: null }
  } }],
  test: { ...base.test, include: ['apps/host/test/mobile-snapshot-directories.test.ts', 'apps/host/test/snapshot-observation.test.ts'], environment: 'node' } }
