import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/browser-structured-output.ts'
await verifyRendererSourceMutations({
  name: 'browser-structured-output-mutations',
  tests: ['apps/desktop/test/browser-structured-output.test.ts'],
  sources: [file, 'apps/desktop/src/shared/browser-structured-output.ts', 'apps/desktop/src/main/browser-result-artifact.ts'],
  mutations: [
    { label: 'missing-filled-with-empty-default', file,
      before: "if (found.length === 0) return { ...identity, status: 'missing', detail: 'No element matched in the complete rooted scan.' }",
      after: "if (found.length === 0) return { ...identity, status: 'read', value: '' }" },
    { label: 'empty-number-coerced-to-zero', file,
      before: 'try { value = JSON.parse(value.trim()) } catch { value = undefined }',
      after: 'value = Number(value)' },
    { label: 'unfinished-scan-claims-absence-or-uniqueness', file,
      before: "if (!complete) return { ...identity, status: 'truncated', detail: 'Element scan budget ended before uniqueness or absence was established.' }",
      after: "if (false) return { ...identity, status: 'truncated', detail: 'Element scan budget ended before uniqueness or absence was established.' }" },
    { label: 'element-budget-disconnected', file, before: 'work.visitedElements < limits.elements', after: 'true' },
    { label: 'text-node-budget-disconnected', file, before: 'work.textNodes >= limits.textNodes', after: 'false' },
    { label: 'actual-frame-disconnection-ignored', file,
      before: "if (!read.current) return failed('page-changed', 'The rooted Browser document changed during extraction; old fields were not registered as current.', read.work)",
      after: "if (false) return failed('page-changed', 'The rooted Browser document changed during extraction; old fields were not registered as current.', read.work)" },
    { label: 'wrong-original-navigation-accepted', file,
      before: 'artifact.navigationId !== source.navigationId', after: 'false' },
    { label: 'sole-result-registration-disconnected', file,
      before: 'const artifact = await context.register(document, source)', after: "throw new Error('Result registration disconnected'); const artifact = await context.register(document, source)" },
    { label: 'long-preview-claims-complete-inline-value', file,
      before: 'const inline = valueBytes <= BROWSER_STRUCTURED_LIMITS.previewBytes', after: 'const inline = true' },
    { label: 'document-parser-accepts-different-field-source', file,
      before: 'field.source.selector === requested.source.selector', after: 'true' },
    { label: 'document-parser-accepts-wrong-observed-type', file,
      before: 'typeof field.value === field.type', after: 'true' },
    { label: 'postsave-current-promise-not-awaited', file,
      before: "if (!(await awaitCurrent())) return failedCurrent('The Browser document changed while saving; the captured artifact is not presented as current.', read.work)",
      after: "if (!awaitCurrent()) return failedCurrent('The Browser document changed while saving; the captured artifact is not presented as current.', read.work)" },
    { label: 'unverified-current-claims-page-change', file,
      before: "? failed('unavailable', currentWarning, work) : failed('page-changed', warning, work)",
      after: "? failed('page-changed', currentWarning, work) : failed('page-changed', warning, work)" }
  ]
})
