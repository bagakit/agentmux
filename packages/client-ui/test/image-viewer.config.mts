import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.IMAGE_VIEWER_MUTATION
const changes = {
  anchor: ['packages/client-ui/src/lib/image-view-transform.ts', 'const ratio = next.scale / view.scale', 'const ratio = next.scale / view.scale; anchor = { x: 0, y: 0 }'],
  bounds: ['packages/client-ui/src/lib/image-view-transform.ts', 'return { scale, x: Math.max(-boundX, Math.min(boundX, view.x)), y: Math.max(-boundY, Math.min(boundY, view.y)) }', 'return { scale, x: view.x, y: view.y }'],
  wheel: ['packages/client-ui/src/components/ConversationImageViewport.tsx', "host.addEventListener('wheel', wheel, { passive: false })", 'void wheel'],
  drag: ['packages/client-ui/src/components/ConversationImageViewport.tsx', 'const zoom = (factor: number) => { endDrag();', 'const zoom = (factor: number) => {'],
} as const
export default defineConfig({ root,
  plugins: [{ name: 'actual-image-viewer-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    assert.ok(mutation in changes, 'Unknown image viewer mutation')
    const [target, needle, replacement] = changes[mutation as keyof typeof changes]
    if (relative(root, id) !== target) return
    assert.equal(source.split(needle).length - 1, 1, 'The actual mutation target must be unique')
    if (process.env.IMAGE_VIEWER_MUTATION_HITS) appendFileSync(process.env.IMAGE_VIEWER_MUTATION_HITS, target + '\n')
    return { code: source.replace(needle, replacement), map: null }
  } }],
  test: { include: ['packages/client-ui/test/conversation-image-viewer.test.tsx', 'packages/client-ui/test/conversation-image-gallery.test.tsx',
    'packages/client-ui/test/conversation-native-resource.test.tsx', 'packages/client-ui/test/conversation-image-styles.test.tsx'],
    environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1 }
})
