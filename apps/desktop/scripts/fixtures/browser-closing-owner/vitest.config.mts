import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../test/vitest.browser-cold-owner.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string]> = {
  retain: ['views.set(view, { id: owner.id, workspaceId: owner.workspaceId, storage: owner.storage, requestedUrl: owner.requestedUrl, viewport: cloneBrowserViewport(owner.viewport), view })', 'void owner'],
  private: ['try { this.retryClosingViews(previousClosures) } catch (error) { failures.push(error) }', '/* mutant: old private incarnations lose their explicit Close retry */'],
  notice: ['try { this.emit(current) } catch (error) { console.warn(\'Browser cleanup update was not delivered:\', error) }', '/* mutant: leave the new page with a stale cleanup notice */']
}

export default defineConfig({ ...base, root, cacheDir: resolve(root, '.tmp/browser-closing-owner-cache'),
  plugins: [{ name: 'browser-closing-owner-mutation', enforce: 'pre', transform(source, id) {
    if (relative(root, id.split('?')[0]!) !== 'apps/desktop/src/main/browser-view-manager.ts') return
    const mutation = process.env.AGENTMUX_CLOSING_OWNER_MUTANT
    let code = source
    if (mutation) {
      const change = mutations[mutation]
      assert.ok(change, 'Unknown native owner mutation')
      assert.equal(source.split(change[0]).length - 1, 1, 'Mutation must have one exact production anchor')
      code = source.replace(change[0], change[1])
      process.stderr.write(`MUTATION_APPLIED=${mutation}\n`)
    }
    const receipt = process.env.AGENTMUX_CLOSING_OWNER_LOADED
    if (receipt) appendFileSync(receipt, JSON.stringify({ path: relative(root, id), mutation: mutation ?? null,
      sourceSHA256: createHash('sha256').update(source).digest('hex'),
      effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/browser-initial-document.test.ts'], passWithNoTests: false }
})
