import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const owner = 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx'
const mutations = {
  'ignore-created-identity': ['registrationRetry.current?.()', 'void 0'],
  'miss-pending-identity': ['if (!cancelled && attemptNavigationId !== latest.current.navigationId) retry()', 'void 0'],
  'reuse-older-registration-failure': ['registering = true\n      registrationFailed = false', 'registering = true'],
  'steal-input-focus': ["{ kind: 'select', focus: 'preserve' }", "{ kind: 'select' }"],
  'revive-cancelled-registration': ['if (cancelled) { await api.browser.removePresentation(registered.leaseId); return }', 'if (false) { await api.browser.removePresentation(registered.leaseId); return }'],
  'keep-stale-registration-notice': ['setNotice(null) // A real lease confirms this registration.', 'void 0'],
  'drop-delayed-selection': ['void media.registered(registered, latest.current.inputSelected, true).then', 'void media.ensureCapture(registered).then'],
  'block-resize-on-capture': ['void media.registered(registered, latest.current.inputSelected, true).then', 'await media.registered(registered, latest.current.inputSelected, true).then'],
  'consume-hidden-selection': ['if (visible && initialInputOwner && !inputChosen.current)', 'if (initialInputOwner && !inputChosen.current)'],
  'accept-unconfirmed-selection': ["if (receipt.outcome !== 'selected') throw new Error", 'if (false) throw new Error'],
  'repeat-failed-capture': ['if (captureFailed.current) return Promise.resolve()', 'void 0'],
  'drop-live-preview-retry': ['captureFailed.current = false\n    return ensureCapture(lease)', 'return ensureCapture(lease)'],
  'put-notice-under-native-page': ['<div className="browser-presentation">', '<div className="browser-presentation" data-native-browser-stage={browserId}>'],
  'retry-hidden-preview': ['disabled={!presentation.visible || blocked}', 'disabled={false}'],
  'capture-after-owner-unmount': ['if (visible && current === generation.current) await ensureCapture(lease)', 'if (visible) await ensureCapture(lease)'],
  'revive-ready-capture': ['// The owner may have unmounted while the acknowledgement was in flight.\n        if (current !== generation.current)',
    '// The owner may have unmounted while the acknowledgement was in flight.\n        if (false)'],
  'block-geometry-on-capture': ['observe() // Native geometry stays current while preview capture is pending.\n      await media.registered(registered, latest.current.inputSelected, geometry().visible)',
    'await media.registered(registered, latest.current.inputSelected, geometry().visible)\n      if (!cancelled) observe()'],
  'drop-explicit-retry': ['onClick={() => registrationRetry.current?.(true)}', 'onClick={() => {}}']
} as const
export default defineConfig({ root, esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
  plugins: [{ name: 'actual-stage-registration-owner', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(root + '/apps/desktop/src/')) return
    let code = source
    const mutation = process.env.AGENTMUX_STAGE_REGISTRATION_MUTATION as keyof typeof mutations | undefined
    if (mutation && path === resolve(root, owner)) {
      const change = mutations[mutation]; assert.ok(change, 'Known registration mutation')
      assert.equal(source.split(change[0]).length - 1, 1, 'Unique loaded mutation anchor')
      code = source.replace(change[0], change[1])
    }
    if (process.env.AGENTMUX_STAGE_REGISTRATION_LOADED) appendFileSync(process.env.AGENTMUX_STAGE_REGISTRATION_LOADED,
      JSON.stringify({ path: relative(root, path), sourceSHA256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(code).digest('hex'), mutated: source !== code, mutation: mutation ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  }}],
  cacheDir: resolve(root, '.tmp/stage-registration-vitest-cache'),
  test: { include: ['apps/desktop/test/browser-presentation-registration-recovery.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 5000 }
})
