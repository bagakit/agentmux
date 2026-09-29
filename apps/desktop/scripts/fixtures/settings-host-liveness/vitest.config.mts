import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const probe = resolve(process.env.AGENTMUX_HOST_LIVENESS_EVIDENCE ?? resolve(root, '.bagakit/design/settings-followups-20261004/host-liveness-evidence/direct'))
const mutant = process.env.AGENTMUX_HOST_LIVENESS_MUTANT ?? 'baseline'
const observedPaths = [
  'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
  'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/hosts.tsx',
  'apps/desktop/src/renderer/src/components/settings/use-resource-drafts.ts',
  'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/main/config-owner.ts',
  'apps/desktop/src/main/runtime-config-transaction.ts',
  'apps/desktop/src/main/ipc.ts'
]
mkdirSync(probe, { recursive: true })
const expected = new Map(observedPaths.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]))
writeFileSync(resolve(probe, 'source-inputs.json'), JSON.stringify(Object.fromEntries(expected), null, 2) + '\n')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function replaceOne(code: string, anchor: string, replacement: string): string {
  assert.equal(code.split(anchor).length - 1, 1, `Exactly one nonempty observation anchor: ${anchor}`)
  return code.replace(anchor, replacement)
}
function profiler(code: string, opening: string, id: string): string {
  code = replaceOne(code, opening, opening.replace('  return (\n', `  return (\n    <SourceSettingsProfiler id="${id}" onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) =>\n      globalThis.__settingsProbeRecord?.('commit', id, { phase, actualDuration, baseDuration, startTime, commitTime })}>\n`))
  code = replaceOne(code, '    </div>\n  )\n}', '    </div>\n    </SourceSettingsProfiler>\n  )\n}')
  return `import { Profiler as SourceSettingsProfiler } from 'react'\n${code}`
}
export default defineConfig({
  ...original,
  root,
  esbuild: { jsx: 'automatic' },
  cacheDir: resolve(probe, 'cache'),
  plugins: [{
    name: 'bounded-settings-source-observation', enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]!, path = relative(root, file)
      if (!expected.has(path)) return
      if (expected.has(path)) assert.equal(sha(source), expected.get(path), `Source identity changed: ${path}`)
      let code = source
      if (path.endsWith('/components/SettingsPanel.tsx')) {
        code = replaceOne(code, "  const config = useAppStore((state) => state.config)",
          "  globalThis.__settingsProbeRecord?.('render', 'SettingsPanel', { onClose })\n  const config = useAppStore((state) => state.config)")
        code = profiler(code, '  return (\n    <div className="settings-page"', 'SettingsPanel')
      }
      if (path.endsWith('/components/settings/HostSettingsPane.tsx')) {
        code = replaceOne(code, '  const resource = useResourceDrafts(', "  globalThis.__settingsProbeRecord?.('render', 'HostSettingsPane')\n  const resource = useResourceDrafts(")
        code = replaceOne(code, '  // The keyed Host card owns this component',
          "  globalThis.__settingsProbeRecord?.('render', 'HostConnectionFields', { hostId: host.id })\n  // The keyed Host card owns this component")
        code = replaceOne(code, 'sessions.filter((session) => session.hostId === host.id)',
          'sessions.filter((session) => { globalThis.__settingsProbeVisit?.(host.id); return session.hostId === host.id })')
        if (mutant === 'sessions-live') code = replaceOne(code,
          'active ? state.sessions : NO_SESSIONS', 'state.sessions')
        if (mutant === 'checks-live') code = replaceOne(code,
          'active ? state.hostChecks : NO_HOST_CHECKS', 'state.hostChecks')
        if (mutant === 'frozen-hidden-baseline') {
          code = replaceOne(code, '  const resource = useResourceDrafts(',
            '  const [initialHosts] = useState(() => config.hosts)\n  const resource = useResourceDrafts(')
          code = replaceOne(code, 'Object.fromEntries(config.hosts.map((host) => [host.id, host]))',
            'Object.fromEntries((active ? config.hosts : initialHosts).map((host) => [host.id, host]))')
        }
        code = profiler(code, '  return (\n    <div className="settings-pane-stack"', 'HostSettingsPane')
      }
      if (path.endsWith('/settings/modules/hosts.tsx') && mutant === 'module-active') {
        code = replaceOne(code, 'active={active}', 'active={true}')
      }
      appendFileSync(resolve(probe, 'loaded-source.jsonl'), JSON.stringify({ path,
        originalSHA256: sha(source), consumedSHA256: sha(code), bytes: Buffer.byteLength(code),
        observationOnly: code !== source && mutant === 'baseline', mutant }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: {
    ...original.test,
    include: ['apps/desktop/test/settings-host-liveness.test.tsx',
      'apps/desktop/test/settings-host-disclosure.test.tsx', 'apps/desktop/test/settings-host-draft.test.tsx',
      'apps/desktop/test/settings-hosts-control.test.ts', 'apps/desktop/test/settings-host-feedback.test.tsx',
      'apps/desktop/test/settings-save-feedback.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1
  }
})
