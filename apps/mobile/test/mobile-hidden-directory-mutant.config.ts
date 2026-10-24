import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

// Mutation is applied only to Vite's loaded module, never to the shared source tree.
export default mergeConfig(base, { plugins: [{
  name: 'restore-unmemoized-mobile-directory', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith('/src/navigation/MobileSpatialNavigation.tsx')) return
    const start = 'export const MobileSpatialNavigation = memo(function MobileSpatialNavigation('
    if (!code.includes(start) || !code.trimEnd().endsWith('})')) throw new Error('Directory mutation did not match the loaded production module')
    return code.replace(start, 'export function MobileSpatialNavigation(').replace(/\}\)\s*$/, '}\n')
  }
}] })
