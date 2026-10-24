import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'
const mutations: Record<string, string> = {
  client: 'current.sessionId !== original.sessionId || !current.visible',
  session: 'current.client !== original.client || !current.visible',
  visible: 'current.client !== original.client || current.sessionId !== original.sessionId'
}
const mutant = process.env.AGENTMUX_HEADER_FOCUS_MUTANT ?? ''
if (!mutations[mutant]) throw new Error('Expected one original focus guard mutation')
export default mergeConfig(base, { plugins: [{ name: 'focus-original-object-mutant', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith('/src/MobileApp.tsx')) return
    const marker = 'current.client !== original.client || current.sessionId !== original.sessionId || !current.visible'
    if (code.split(marker).length !== 2) throw Error('Original focus guard did not match loaded MobileApp')
    return code.replace(marker, mutations[mutant]!)
  }
}] })
