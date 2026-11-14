import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mobileRequire = createRequire(resolve(root, 'apps/mobile/package.json'))
const hook = 'apps/mobile/src/navigation/useMoteQuickDraft.ts'
const editor = 'apps/mobile/src/navigation/MobileMoteQuickEditor.tsx'
const variants: Record<string, { file: string; before: string; after: string }> = {
  'require-display': { file: hook, before: '|| conflicted.current ||\n', after: '|| conflicted.current || !destination ||\n' },
  'overwrite-later-edit': { file: hook, before: 'const latestDraft = current.current, confirmed =', after: 'const latestDraft = submitted, confirmed =' },
  'forget-unknown-save': { file: hook, before: "blockedAttemptId: resolved.phase === 'unknown' ? input.operationId : null", after: 'blockedAttemptId: null' },
  'require-display-copy': { file: editor, before: '保存偏好无需选择展示位置，也不会切换主对话。', after: '保存位置还没确认，可以重新核对。' },
  'block-source-first': { file: hook, before: "const input = { kind: 'quick' as const, target, includeChoices: false }", after: "const input = { kind: 'quick' as const, target, includeChoices: true }" },
  'late-candidate-overwrite': { file: hook, before: 'setRead(previous => previous ? { ...previous, choices: mergeMoteQuickChoices(previous.choices, choices) } : previous)', after: 'setRead(previous => previous ? { ...previous, choices: mergeMoteQuickChoices(previous.choices, choices) } : previous); void retain({ ...current.current, values: discovery.defaults ?? {} })' },
  'keep-reader-open': { file: hook, before: 'return () => { readEpoch.current++; readController.current?.abort() }', after: 'return () => { readEpoch.current++ }' }
}
const mutation = process.env.MOBILE_SETTINGS_MUTATION
if (mutation && !variants[mutation]) throw Error('Unknown Mobile settings mutation')
const sources = new Set([hook, editor, 'apps/host/src/mote-quick-preferences.ts', 'packages/core/src/mote/preferences.ts', 'packages/core/src/public-rpc-service.ts'])
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/mobile-settings-placement', mutation ?? 'baseline'),
  plugins: [react(), { name: 'mobile-settings-original-sources', enforce: 'pre',
    resolveId(source) {
      if (/^(?:react|react-dom)(?:\/|$)/u.test(source)) return mobileRequire.resolve(source)
      if (source === '@agentmux/identity/runtime-source') return
      if (source.startsWith('@agentmux/')) return workspaceSourceExport(root, source)
    },
    transform(source, id) {
      const file = relative(root, id.split('?')[0]!)
      if (!sources.has(file)) return
      let loaded = source
      const variant = mutation && variants[mutation]
      if (variant && variant.file === file) {
        if (loaded.split(variant.before).length !== 2) throw Error('One actual Mobile settings mutation anchor required: ' + mutation)
        loaded = loaded.replace(variant.before, variant.after)
      }
      const report = process.env.MOBILE_SETTINGS_LOADED
      if (!report) return loaded === source ? undefined : { code: loaded, map: null }
      const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
      const record = { file, sourceSHA256: sha(source), rawSHA256: sha(readFileSync(resolve(root, file), 'utf8')), loadedSHA256: sha(loaded), mutation: loaded === source ? null : mutation }
      return { code: "import { appendFileSync as __mobileSettingsLoaded } from 'node:fs'; __mobileSettingsLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
    }
  }], resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  test: { include: ['apps/mobile/test/mote-settings-placement.test.tsx'], setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')],
    environment: 'happy-dom', environmentOptions: { happyDOM: { width: 390, height: 844 } }, restoreMocks: true,
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000, hookTimeout: 15000 }
})
