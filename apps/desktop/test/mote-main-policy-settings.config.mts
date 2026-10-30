import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const aliases = [...(base.resolve!.alias as import('vite').Alias[])]
for (const name of ['capsule']) {
  const directory = resolve(root, 'packages', name), manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  for (const [entry, value] of Object.entries(manifest.exports) as [string, { import: string }][]) {
    const stem = resolve(directory, value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
    aliases.unshift({ find: `@agentmux/${name}${entry === '.' ? '' : entry.slice(1)}`, replacement: existsSync(stem) ? stem : stem.replace(/\.ts$/, '.tsx') })
  }
}
export default defineConfig({
  ...base,
  resolve: { ...base.resolve, alias: aliases },
  root, cacheDir: resolve(root, '.tmp/mote-main-policy-settings-vitest'),
  plugins: [{ name: 'policy-ui-loaded-source', enforce: 'pre', transform(code, id) {
    const request = process.env.AGENTMUX_POLICY_UI_MUTATION
    const marker = process.env.AGENTMUX_POLICY_UI_LOADED
    if (!marker || id.includes('?')) return
    const path = id.replace(root + '/', '')
    const mutations: Record<string, [string, string, string]> = {
      'desktop-policy': ['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', 'conversationRollover: { kind, idleMs: Number(value) * 60000 }', 'conversationRollover: { kind, idleMs: Number(value) * 6000 }'],
      'desktop-invalid': ['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', "if (rolloverKind === 'idle' && !validRolloverMinutes(rolloverMinutes))", "if (false && rolloverKind === 'idle' && !validRolloverMinutes(rolloverMinutes))"],
      'desktop-retain': ['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', 'rolloverMinutes: current.rolloverMinutes', "rolloverMinutes: '10'"],
      'desktop-late': ['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', 'else update({ ...form.current }) // Raw edits also fence a late save from closing this later draft.', 'else { /* lost raw-draft save fence */ }'],
      'mobile-policy': ['apps/mobile/src/navigation/MobileMoteQuickEditor.tsx', 'conversationRollover: { kind, idleMs: Number(value) * 60000 }', 'conversationRollover: { kind, idleMs: Number(value) * 6000 }'],
      'mobile-invalid': ['apps/mobile/src/navigation/MobileMoteQuickEditor.tsx', "if (rolloverKind === 'idle' && !validRolloverMinutes(rolloverMinutes))", "if (false && rolloverKind === 'idle' && !validRolloverMinutes(rolloverMinutes))"],
      'mobile-retain': ['apps/mobile/src/navigation/useMoteQuickDraft.ts', '...(conversationRolloverEditor ? { conversationRolloverEditor } : {})', '...({})'],
      'mobile-unknown': ['apps/mobile/src/navigation/useMoteQuickDraft.ts', "blockedAttemptId: resolved.phase === 'unknown' ? input.operationId : null", 'blockedAttemptId: null'],
      'mobile-absent': ['apps/mobile/src/navigation/useMoteQuickDraft.ts', 'values: submitted.values, destination,', "values: { ...submitted.values, conversationRollover: submitted.values.conversationRollover ?? { kind: 'idle', idleMs: 60000 } }, destination,"],
    }
    const target = request && mutations[request]
    if (target && path === target[0]) {
      if (code.split(target[1]).length !== 2) throw Error('Loaded mutation anchor must match exactly once: ' + request)
      const mutated = code.replace(target[1], target[2])
      const sourceHash = createHash('sha256').update(code).digest('hex'), loadedHash = createHash('sha256').update(mutated).digest('hex')
      appendFileSync(marker, JSON.stringify({ phase: 'loaded', mutation: request, path, sourceHash, loadedHash }) + '\n')
      return mutated + `\nimport { appendFileSync as __policyUiEvidence } from 'node:fs'; __policyUiEvidence(${JSON.stringify(marker)}, ${JSON.stringify(JSON.stringify({ phase: 'evaluated', mutation: request, path, sourceHash, loadedHash }) + '\n')});\n`
    }
    if (!request && ['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx', 'apps/mobile/src/navigation/MobileMoteQuickEditor.tsx', 'apps/mobile/src/navigation/useMoteQuickDraft.ts', 'apps/mobile/src/recovery/mote-quick-drafts.ts'].includes(path)) {
      const sourceHash = createHash('sha256').update(code).digest('hex')
      appendFileSync(marker, JSON.stringify({ phase: 'loaded', path, sourceHash, loadedHash: sourceHash }) + '\n')
      return code + `\nimport { appendFileSync as __policyUiEvidence } from 'node:fs'; __policyUiEvidence(${JSON.stringify(marker)}, ${JSON.stringify(JSON.stringify({ phase: 'evaluated', path, sourceHash, loadedHash: sourceHash }) + '\n')});\n`
    }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/mote-main-policy-settings.test.tsx'], globalSetup: [], testTimeout: 15000 }
})
