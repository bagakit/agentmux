import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const mutation = process.env.MODAL_MUTATION
const mutations: Record<string, [string, string]> = {
  'retain-inactive-behavior': ['const active = !context || context.requestedOpen && context.failure === null', 'const active = true'],
  'detach-nonmodal': ['const inheritedContainer = useModalOverlayContainer(container)', 'const inheritedContainer = container'],
  'reuse-attempt': ['const id = `amux-modal-${identity}-${attempt.generation}`', 'const id = `amux-modal-${identity}`']
}
if (mutation) assert.ok(mutation in mutations, 'Unknown actual Modal mutation')

export default defineConfig({
  root,
  plugins: [{ name: 'actual-shared-modal-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation || !id.split('?')[0]!.endsWith('/packages/client-ui/src/components/Modal.tsx')) return
    const [needle, replacement] = mutations[mutation]!
    assert.equal(source.split(needle).length, 2, 'Actual Modal mutation anchor must be unique')
    return source.replace(needle, replacement)
  } }],
  test: { include: ['packages/client-ui/test/modal.test.tsx'], environment: 'happy-dom', globals: false }
})
