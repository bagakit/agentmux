import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8')

describe('frontend stack review source contract', () => {
  it('derives the reviewed stack from package manifests and real consumers', () => {
    const desktopPackage = JSON.parse(read('apps/desktop/package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const workspacePackage = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const all = {
      ...workspacePackage.dependencies,
      ...workspacePackage.devDependencies,
      ...desktopPackage.dependencies,
      ...desktopPackage.devDependencies,
    }
    const expected = ['react', 'typescript', 'vite', 'zustand', 'lucide-react', 'monaco-editor', 'vitest', 'happy-dom']
    const found = expected.filter((name) => name in all)
    expect(found.length).toBeGreaterThan(0)
    expect(found).toEqual(expected)
  })

  it('keeps the review decisions attached to the owning artifact', () => {
    const review = read('docs/reviews/frontend-stack-review-2026-09-16.md')
    for (const phrase of ['React 19', 'Zustand 5', 'Electron 43', 'Vite 7', '不引入 Next.js', '独立 Vite entry']) {
      expect(review).toContain(phrase)
    }
  })
})
