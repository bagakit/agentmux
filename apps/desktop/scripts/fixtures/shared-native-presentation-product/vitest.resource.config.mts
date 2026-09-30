import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root,
  plugins: [...(original.plugins ?? []), {
    name: 'actual-loaded-browser-presentation-resource', enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0] !== resolve(root, 'apps/desktop/src/main/browser-view-manager.ts')) return
      const mutations = {
        'requester-frame': ["request.frame !== capture.document.frame || request.frame.url !== capture.document.url ||", 'false ||'],
        'local-hide': ["if (!this.hasVisiblePresentation(lease.entry)) this.revokePresentationCapture(lease.entry, 'no-visible-presentations')\n  }\n\n  removePresentation", "this.revokePresentationCapture(lease.entry, 'no-visible-presentations')\n  }\n\n  removePresentation"],
        'source-navigation': ['if (!details.isSameDocument) this.releaseUploadFiles(entry)', "if (!details.isSameDocument) { this.revokePresentationCapture(entry, 'source-replaced'); this.releaseUploadFiles(entry) }"],
        'wrong-input': ['this.setBounds(lease.entry.id, lease.geometry.bounds)\n    lease.entry.inputLeaseId', 'this.setBounds(lease.entry.id, { ...lease.geometry.bounds, x: 24 })\n    lease.entry.inputLeaseId']
      } as const
      const mutation = process.env.AGENTMUX_BROWSER_PRESENTATION_MUTATION as keyof typeof mutations | undefined
      let code = source
      if (mutation) {
        const change = mutations[mutation]
        assert.ok(change, 'Known presentation resource mutation')
        assert.equal(source.split(change[0]).length - 1, 1, 'Unique actual loaded anchor')
        code = source.replace(change[0], change[1])
      }
      if (process.env.AGENTMUX_BROWSER_PRESENTATION_LOADED) appendFileSync(process.env.AGENTMUX_BROWSER_PRESENTATION_LOADED,
        JSON.stringify({ path: 'apps/desktop/src/main/browser-view-manager.ts', mutation: mutation ?? null,
          originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
      return code === source ? undefined : { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/browser-presentation-resource.test.ts'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false }
})
