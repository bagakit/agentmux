import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const selected = [
  'product-object-id-main.test.ts', 'browser-profile-store.test.ts', 'browser-input-history-store.test.ts',
  'browser-result-artifact.test.ts', 'browser-step-evidence.test.tsx', 'browser-downloads.test.ts',
  'browser-uploads.test.ts', 'browser-upload-document-lifetime.test.ts', 'browser-demonstration-recorder.test.ts',
  'browser-task-batch.test.ts', 'browser-task-assets.test.tsx', 'browser-external-target.test.ts',
  'settings-workspace-add-control.test.ts', 'worktree-service.test.ts', 'toolkit-owner.test.ts',
  'toolkit-custom-owner.test.ts', 'topic-knowledge-owner.test.ts', 'topic-knowledge-content.test.ts',
  'topic-knowledge-observation.test.ts'
].map(name => 'apps/desktop/test/' + name).concat('packages/core/test/topic-cui.test.ts')
const mutations: Record<string, { file: string; before: string; after: string; test: string }> = {
  'collision-index': { file: 'browser-result-artifact.ts', before: 'while (this.files.has(id))', after: 'while (false)', test: 'browser-result-artifact.test.ts' },
  'new-path': { file: 'browser-result-artifact.ts', before: 'isObjectId(value) || ', after: '', test: 'browser-result-artifact.test.ts' },
  'old-path': { file: 'browser-result-artifact.ts', before: " || typeof value === 'string' && LEGACY_ID.test(value)", after: '', test: 'browser-result-artifact.test.ts' },
  'unsafe-path': { file: 'browser-result-artifact.ts', before: 'isObjectId(value) || ', after: "typeof value === 'string' || ", test: 'browser-result-artifact.test.ts' },
  'task-owner': { file: 'browser-task-assets.ts', before: 'options.id ?? mintObjectId', after: "options.id ?? (() => '11111111-1111-4111-8111-111111111111')", test: 'product-object-id-main.test.ts' },
  'device-owner': { file: '../../../host/src/device-authority.ts', before: 'hostId: mintObjectId()', after: "hostId: '11111111-1111-4111-8111-111111111111'", test: 'product-object-id-main.test.ts' },
  'upload-collision': { file: 'browser-uploads.ts', before: "if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error", after: 'throw error', test: 'browser-uploads.test.ts' }
}
const mutation = process.env.MAIN_ID_MUTATION ? mutations[process.env.MAIN_ID_MUTATION] : undefined
if (process.env.MAIN_ID_MUTATION && !mutation) throw new Error('Unknown Main identity mutation')
const sourcePath = (file: string) => resolve('apps/desktop/src/main', file)
export default defineConfig({
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'main-identity-production-source', enforce: 'pre', transform(source, id) {
    const clean = id.split('?')[0]!
    if (!clean.includes('/apps/desktop/src/main/') && !clean.endsWith('/apps/host/src/device-authority.ts')) return
    let code = source
    if (mutation && clean === sourcePath(mutation.file)) {
      if (!code.includes(mutation.before)) throw new Error('Mutation failed to load its actual target')
      code = code.replace(mutation.before, mutation.after)
    }
    if (process.env.MAIN_ID_BASELINE === 'topic' && clean === sourcePath('topic-knowledge.ts'))
      code = readFileSync(resolve('.local/state/unified-product-id/main/baseline/apps/desktop/src/main/topic-knowledge.ts'), 'utf8')
    if (process.env.MAIN_ID_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MAIN_ID_LOADED, JSON.stringify({ id: clean, mutation: code === source ? null : process.env.MAIN_ID_MUTATION ?? process.env.MAIN_ID_BASELINE, sourceSHA: hash(source), loadedSHA: hash(code) }) + '\n')
    }
    return { code, map: null }
  } }],
  test: { include: process.env.MAIN_ID_BASELINE || process.env.MAIN_ID_DOCUMENTS ? ['apps/desktop/test/topic-knowledge-documents.test.ts'] : mutation ? ['apps/desktop/test/' + mutation.test] : selected,
    setupFiles: [resolve('vitest.setup.ts')], maxWorkers: 1 }
})
