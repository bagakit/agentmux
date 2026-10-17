import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const mutation = process.env.AGENTMUX_SETTINGS_POLICY_MUTATION ? JSON.parse(readFileSync(process.env.AGENTMUX_SETTINGS_POLICY_MUTATION, 'utf8')) : null
export default defineConfig({ ...base,
  plugins: mutation ? [{ name: 'settings-policy-owning-source-mutation', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file)) return
    if (source.split(mutation.before).length !== 2) throw new Error('Expected one owning source mutation anchor')
    const changed = source.replace(mutation.before, mutation.after)
    writeFileSync(mutation.receipt, JSON.stringify({ file: mutation.file, loaded: true,
      before: createHash('sha256').update(source).digest('hex'), after: createHash('sha256').update(changed).digest('hex') }))
    return { code: changed, map: null }
  } }, { name: 'settings-policy-compiled-mutation', enforce: 'post', transform(code, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file)) return
    const receipt = JSON.parse(readFileSync(mutation.receipt, 'utf8'))
    writeFileSync(mutation.receipt, JSON.stringify({ ...receipt, compiled: createHash('sha256').update(code).digest('hex') }))
  } }] : [],
  test: { ...base.test, include: [
    'apps/desktop/test/settings-policy-polish.test.tsx',
    'apps/desktop/test/session-continuity-settings.test.tsx',
    'apps/desktop/test/settings-message-tool.test.tsx',
    'apps/desktop/test/a2a-settings.test.tsx',
    'apps/desktop/test/general-settings-diagnostics.test.tsx',
    'apps/desktop/test/settings-keyboard-shortcuts.test.tsx',
    'apps/desktop/test/amux-protocol-settings.test.tsx'
  ] }
})
