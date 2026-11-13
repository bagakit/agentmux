import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import assert from 'node:assert/strict'
const owner = '/apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'
export default defineConfig({ ...base, cacheDir: '.tmp/focus-consumer-cost-vitest', plugins: [...(base.plugins ?? []), {
  name: 'observe-original-focus-render', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (!id.replaceAll('\\', '/').endsWith(owner)) return
    const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const owners = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'GlobalFocusSurface')
    assert.equal(owners.length, 1, 'The actual production Global Focus render must be observed')
    const body = owners[0]!.body; assert.ok(body)
    const at = body.getStart(ast) + 1
    return source.slice(0, at) + '\n;(globalThis as any).__agentmuxFocusCostRender?.();\n' + source.slice(at)
  }
}], test: { ...base.test,
  include: ['apps/desktop/test/focus-consumer-cost.test.tsx', 'apps/desktop/test/focus-collection-concurrent.test.tsx',
    'apps/desktop/test/focus-group-heading-menu.test.tsx', 'apps/desktop/test/focus-collection-layout.test.tsx'], testTimeout: 20000 } })
