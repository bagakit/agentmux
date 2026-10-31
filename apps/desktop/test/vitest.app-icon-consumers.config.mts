import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const edits: Record<string, [string, string, string]> = {
  bot: ['apps/desktop/src/renderer/src/components/settings/BotEnrollmentPane.tsx',
    'desktopBotCreationPreset(name, useAppStore.getState().config?.appearance.appIcon)', 'desktopBotCreationPreset(name)'],
  'host-change': ['apps/host/src/theme-observation.ts', ' || !isDeepStrictEqual(a.appIcon, b.appIcon)', ''],
  'mobile-welcome': ['apps/mobile/src/MobileApp.tsx', 'appIcon={hostAppearance.appIcon}', 'appIcon={undefined}'],
  'missing-observation': ['apps/desktop/src/renderer/src/store.ts',
    'appIconIssue: snapshot.appIconIssue === undefined ? state.appIconIssue : snapshot.appIconIssue', 'appIconIssue: snapshot.appIconIssue ?? null'],
  'mobile-retain': ['apps/mobile/src/appearance/useHostAppearance.ts',
    "else iconIssue = 'Mac 的 App 图标选择不受支持，保留最后确认的图标；请在 Mac 的 Appearance 中重新选择。'",
    "else { setAppIcon(DEFAULT_APP_ICON); iconIssue = 'Mac 的 App 图标选择不受支持，保留最后确认的图标；请在 Mac 的 Appearance 中重新选择。' }"]
}
const mutant = process.env.AGENTMUX_APP_ICON_CONSUMER_MUTANT
assert.ok(!mutant || edits[mutant], 'Only an exact consumer mutation runs')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'actual-app-brand-consumers', enforce: 'pre', resolveId: installedDependency,
    transform(source, file) {
      if (!mutant || !file.endsWith(edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(source.split(before).length, 2, 'One original production consumer anchor')
      if (process.env.AGENTMUX_APP_ICON_MUTATION_LOG) appendFileSync(process.env.AGENTMUX_APP_ICON_MUTATION_LOG, file + '\n')
      return { code: source.replace(before, after), map: null }
    } }],
  test: { include: ['apps/desktop/test/app-icon-asset-consumers.test.ts', 'apps/desktop/test/bot-enrollment-pane.test.tsx',
    'apps/desktop/test/app-brand-icon-notice.test.tsx', 'apps/mobile/test/host-appearance.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts'), resolve(root, 'apps/mobile/test/device-locks.ts')],
    environment: 'happy-dom', maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
