import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-mote-default-entry.config.mts'

const name = process.env.MOBILE_FOCUS_MUTATION, trace = process.env.MOBILE_FOCUS_TRACE
const mutations: Record<string, { before: string; after: string; target: string }> = {
  'hide-sdk': { before: '<section className="mobile-focus-available" aria-label="已有会话">', after: '<section hidden className="mobile-focus-available" aria-label="已有会话">', target: 'shows SDK conversations visibly' },
  'false-empty': { before: 'const focusConfirmed = connected && observation?.focusConfirmed === true', after: 'const focusConfirmed = connected && observation?.catalog !== null && observation !== null', target: 'shows SDK conversations visibly' },
  'drop-retained': { before: 'focusRows: missing ? previous?.client === client ? previous.focusRows : undefined : value.catalog.agentPresentation,', after: 'focusRows: value.catalog.agentPresentation,', target: 'retains same-client confirmed' },
  'borrow-client': { before: 'catalogObservation?.client === client ? catalogObservation : null', after: 'catalogObservation !== null ? catalogObservation : null', target: 'does not borrow the previous client' },
  'late-read': { before: '        if (!disposed && directorySource.current.client === client) {', after: '        if (true) {', target: 'ignores a disposed old-client late read' },
  'pending-read': { before: 'const pending = connected && catalogActive && observation?.pending === true', after: 'const pending = observation?.pending === true', target: 'does not report checking' }
}
if (name && !mutations[name]) throw Error('Unknown Focus availability mutation: ' + name)
if (name && !trace) throw Error('Focus availability inverse needs a loaded-source trace')
const owners = ['MobileSpatialNavigation.tsx', 'MobileDirectoryNotice.tsx', 'MobileApp.tsx']
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ ...base, cacheDir: resolve(import.meta.dirname, '../../../.tmp/mobile-focus-availability', name ?? 'baseline'),
  plugins: [...base.plugins ?? [], { name: 'actual-mobile-focus-availability', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!owners.some(owner => file.endsWith('/' + owner))) return
    const mutation = name && file.endsWith('/MobileSpatialNavigation.tsx') ? mutations[name]! : undefined
    if (mutation && source.split(mutation.before).length !== 2) throw Error('Focus availability mutation must match exactly once: ' + name)
    const code = mutation ? source.replace(mutation.before, mutation.after) : source
    const record = { file, mutation: mutation ? name : null, applied: code !== source, originalSHA256: sha(readFileSync(file, 'utf8')), loadedSHA256: sha(code) }
    if (trace) appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...record }) + '\n')
    return { code: code + '\n;globalThis.__mobileFocusAvailabilityLoaded ??= []; globalThis.__mobileFocusAvailabilityLoaded.push(' + JSON.stringify(record) + ');\n', map: null }
  } }], test: { ...base.test, include: ['apps/mobile/test/mobile-focus-availability.test.tsx'], testNamePattern: name ? mutations[name]!.target : undefined,
    maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
