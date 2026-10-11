import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const mutation = process.env.MODAL_MUTATION
const mutations: Record<string, [string, string]> = {
  'retain-inactive-behavior': ['const active = (!context || context.requestedOpen && context.failure === null) && (!boundary || boundary.ready)', 'const active = true'],
  'detach-nonmodal': ['const inheritedContainer = useModalOverlayContainer(container)', 'const inheritedContainer = container'],
  'forget-retired-document': ['const behaviorDocument = inheritedBoundary?.document ?? element?.ownerDocument ?? documentLease.current.document', 'const behaviorDocument = inheritedBoundary?.document ?? element?.ownerDocument'],
  'reuse-attempt': ['const id = `amux-modal-${identity}-${attempt.generation}`', 'const id = `amux-modal-${identity}`'],
  'stale-retained-order': ['if (scope && visible && placed) moveModalScopeToFront(scope)', 'if (false) moveModalScopeToFront(scope!)'],
  'suppress-business-close': ['if (close && (latest.current.failure != null || latest.current.id !== attemptId || latest.current.document !== behaviorDocument))', 'if (close)'],
  'drop-attachment-owner': ['return active ? <DismissableLayer asChild onEscapeKeyDown={onEscapeKeyDown}>', 'return false ? <DismissableLayer asChild onEscapeKeyDown={onEscapeKeyDown}>'],
  'drop-retained-host': ['container={host}', 'container={windowContainer}'],
  'retain-retired-placement': ['host.remove(); setPlacement(null); return', 'host.remove(); return']
}
const dependencyMutations: Record<string, [string, string, string]> = {
  'unpatched-focus-scope': ['react-focus-scope', 'getDocumentFocusScopes', 'upstream-focus-scope'],
  'unpatched-dismissable-layer': ['react-dismissable-layer', 'getDocumentLayers', 'upstream-dismissable-layer'],
  'stale-branch-document': ['react-dismissable-layer', 'getDocumentLayers', 'branch-dependency']
}
if (mutation) assert.ok(mutation in mutations || mutation in dependencyMutations, 'Unknown actual Modal mutation')
function changedSource(source: string, changed: string, file: string): string {
  if (process.env.MODAL_MUTATION_HIT) {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const loadedSHA256 = sha(source), changedSHA256 = sha(changed)
    const loadedFile = `${process.env.MODAL_MUTATION_HIT}.${loadedSHA256}.loaded.txt`, changedFile = `${process.env.MODAL_MUTATION_HIT}.${changedSHA256}.changed.txt`
    writeFileSync(loadedFile, source); writeFileSync(changedFile, changed)
    // Vite can supply transformed dependency code. Bind the disk owner and the
    // actual transform input separately instead of calling both the same bytes.
    appendFileSync(process.env.MODAL_MUTATION_HIT, JSON.stringify({ mutation, file,
      sourceSHA256: sha(readFileSync(file, 'utf8')), loadedSHA256, changedSHA256, loadedFile, changedFile, productionWritten: false }) + '\n')
  }
  return changed
}

export default defineConfig({
  root,
  plugins: [{ name: 'actual-shared-modal-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const path = id.split('?')[0]!
    if (mutation in dependencyMutations) {
      const [name, anchor, snapshot] = dependencyMutations[mutation]!
      if (!path.includes(`/@radix-ui/${name}/dist/index.`)) return
      assert.ok(source.includes(`function ${anchor}(`), 'Actual locked dependency patch owner must be loaded')
      if (snapshot === 'branch-dependency') {
        const needle = '}, [node, contexts, ownerDocument]);'
        assert.equal(source.split(needle).length, 2, 'Actual locked Branch document dependency must be unique')
        return changedSource(source, source.replace(needle, '}, [node, contexts]);'), path)
      }
      const extension = path.endsWith('.mjs') ? 'mjs' : 'js'
      return changedSource(source, readFileSync(`${root}/.local/ui-layering-ssot/${snapshot}/dist/index.${extension}`, 'utf8'), path)
    }
    if (!path.endsWith('/packages/client-ui/src/components/Modal.tsx')) return
    const [needle, replacement] = mutations[mutation]!
    assert.equal(source.split(needle).length, 2, 'Actual Modal mutation anchor must be unique')
    return changedSource(source, source.replace(needle, replacement), path)
  } }],
  test: {
    include: ['packages/client-ui/test/modal.test.tsx'], environment: 'happy-dom', globals: false,
    server: { deps: { inline: [/@radix-ui\//] } }
  }
})
