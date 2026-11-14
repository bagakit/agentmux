import { resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default { ...base, cacheDir: resolve(root, '.tmp/launcher-empty-group-context'),
  plugins: [...base.plugins ?? [], { name: 'empty-group-original-context', enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (!process.env.AGENTMUX_EMPTY_GROUP_CONTEXT_MUTATION || id.split('?')[0] !== resolve(root, 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx')) return
      const anchor = 'const ordinaryEmptyGroup = emptyWorkspaceId !== undefined && !isOriginalSourceWorkspaceProjection(emptyWorkspaceId)'
      if (source.split(anchor).length !== 2) throw Error('Expected one original Group context decision')
      return source.replace(anchor, 'const ordinaryEmptyGroup = false')
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/workbench-source-context-presentation.test.tsx',
    'apps/desktop/test/launcher-empty-group-inputs.test.tsx', 'apps/desktop/test/launcher-source-ui.test.tsx'],
    // Scope Source coverage to inventory truth and retained unknown input; native contract refresh has its own owner.
    testNamePattern: /actual empty Group|actual App|actual owner|rehydrates unsubmitted empty Group inputs|unread original catalogue|failed original catalogue|successful empty original catalogue|future private arrangement|checking the same original Source operation/,
    passWithNoTests: false, testTimeout: 20000, hookTimeout: 20000 }
}
