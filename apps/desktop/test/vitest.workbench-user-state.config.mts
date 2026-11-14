import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_USER_OWNER_MUTATION
const edits: Record<string, { module: string; anchor: string; changed: string; suffix?: string }> = {
  'await-diagnostic': { module: 'workbench-user-state.ts', anchor: 'if (!this.diagnosticRead) this.diagnosticReading = this.readDiagnostic()\n    if (!await this.openDatabase())',
    changed: 'if (!this.diagnosticRead) this.diagnosticReading = this.readDiagnostic()\n    await this.diagnosticReading\n    if (!await this.openDatabase())' },
  'split-input-transaction': { module: 'workbench-user-database.ts', anchor: 'database => transaction(database, () => {\n      const previous = metadata(database)',
    changed: 'database => withoutTransaction(database, () => {\n      const previous = metadata(database)',
    suffix: '\nfunction withoutTransaction(_database, write) { return write() }\n' },
  'hydrate-cold-input': { module: 'workbench-user-database.ts', anchor: 'WHERE cold = 0 AND operation_id IS NOT NULL ORDER BY',
    changed: 'WHERE operation_id IS NOT NULL ORDER BY' },
  'reuse-stale-database-receipt': { module: 'workbench-user-state.ts',
    anchor: '(this.observation.lastConfirmedWrite === null || this.confirmedDatabaseFile === current)', changed: 'true' }
}
if (mutation && !edits[mutation]) throw Error('Unknown native owner mutation')

export default defineConfig({ ...base,
  plugins: [...base.plugins ?? [], { name: 'native-workbench-owner-mutation', enforce: 'pre', transform(source, id) {
    const edit = mutation ? edits[mutation] : undefined
    if (!edit || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/main/' + edit.module) return
    if (source.split(edit.anchor).length !== 2) throw Error('Missing native workbench owner mutation anchor')
    return { code: source.replace(edit.anchor, edit.changed) + (edit.suffix ?? ''), map: null }
  } }], cacheDir: '.cache/workbench-user-state', test: {
  ...base.test, include: ['apps/desktop/test/workbench-user-state.test.ts'], passWithNoTests: false
} })
