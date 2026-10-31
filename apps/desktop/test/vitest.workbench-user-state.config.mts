import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_USER_OWNER_MUTATION

export default defineConfig({ ...base,
  plugins: [...base.plugins ?? [], { name: 'native-owner-diagnostic-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/main/workbench-user-state.ts') return
    if (mutation !== 'await-diagnostic') throw Error('Unknown native owner mutation')
    const anchor = 'if (!this.diagnosticRead) this.diagnosticReading = this.readDiagnostic()'
    if (source.split(anchor).length !== 2) throw Error('Missing native diagnostic mutation anchor')
    return { code: source.replace(anchor, anchor + '\n    await this.diagnosticReading'), map: null }
  } }], cacheDir: '.cache/workbench-user-state', test: {
  ...base.test, include: ['apps/desktop/test/workbench-user-state.test.ts'], passWithNoTests: false
} })
