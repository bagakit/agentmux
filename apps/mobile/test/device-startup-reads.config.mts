import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import base from '../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const variant = process.env.DEVICE_STARTUP_READ_MUTATION, trace = process.env.DEVICE_STARTUP_READ_LOADED
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'navigation-full-read': { file: 'apps/mobile/src/MobileApp.tsx', before: 'return getDeviceWorkface().snapshotNavigation()',
    after: `const { record, issue } = getDeviceWorkface().snapshot()
    return { issue, ...(record.presentation ? { presentation: record.presentation } : {}), workface: { selectedSessionId: record.selectedSessionId, hostUrl: record.hostUrl, panel: record.panel } }` },
  'uploads-full-read': { file: 'apps/mobile/src/conversation/attachment-page-owner.ts',
    before: 'const { uploads: original, recordId } = getDeviceWorkface().snapshotUploads(), listeners = new Set<() => void>()',
    after: 'const workface = getDeviceWorkface(), original = workface.snapshot().record.fileUploads ?? [], recordId = workface.recordIdentity(), listeners = new Set<() => void>()' },
  'duplicate-draft-read': { file: 'apps/mobile/src/conversation/local-drafts.ts',
    before: 'let originalRecord: DeviceWorkface = snapshot.record', after: 'let originalRecord: DeviceWorkface = owner.snapshot().record' }
}
if (variant && !mutations[variant]) throw new Error('Unknown startup read mutation: ' + variant)
const mutation = variant ? mutations[variant] : undefined
const tests = ['test/device-startup-reads.test.tsx', 'test/device-workface.test.tsx', 'test/concurrent-drafts.test.tsx', 'test/mobile-update-workface.test.tsx']
// These unrelated legacy fixture failures reproduce with all three original
// full-read paths restored. Keep the file and assertions unchanged; the new
// startup consumer also checks complete temporary export via createLocalDrafts.
const outsideScope = [
  'one durable mobile workface owner preserves Core spatial ID references from actual mounted space through backup and a new owner without replaying unknown input',
  'one durable mobile workface owner preserves Core spatial ID references from actual mounted survey through backup and a new owner without replaying unknown input',
  'one durable mobile workface owner exports the actual temporary app Session selection beside an unreadable original record without writing it'
]
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const owners = new Set(['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/recovery/device-workface.ts',
  'apps/mobile/src/conversation/local-drafts.ts', 'apps/mobile/src/conversation/attachment-page-owner.ts',
  ...tests.map(file => 'apps/mobile/' + file)])
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default { ...base,
  cacheDir: resolve(trace ? dirname(trace) : resolve(root, '.tmp/mobile-device-startup-reads'), 'vite', variant ?? 'baseline'),
  plugins: [...base.plugins ?? [], { name: 'device-startup-reads-evaluated-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (mutation?.file === file) {
      if (code.split(mutation.before).length !== 2) throw new Error('Startup mutation requires one exact original anchor: ' + variant)
      code = code.replace(mutation.before, mutation.after)
    }
    if (!trace) return code === source ? undefined : code
    const row = { file, mutation: mutation?.file === file ? variant : null, originalSHA256: sha(source), loadedSHA256: sha(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport { appendFileSync as __startupReadEvidence } from 'node:fs'; __startupReadEvidence(${JSON.stringify(trace)}, ${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
  } }],
  test: { ...base.test, include: mutation ? [tests[0]!] : tests,
    testNamePattern: mutation ? 'restores 1572864 bytes through MobileApp' : new RegExp('^(?!.*(?:' + outsideScope.map(escape).join('|') + ')$)'),
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
}
