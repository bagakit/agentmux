import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'
export default mergeConfig(base, { plugins: [{ name: 'old-mote-heading-without-title', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith('/src/MobileApp.tsx')) return
    const before = '<span className="mobile-session-title">{moteConversation ? moteTitle : sessionTitle ?? objectIdentity.name}</span>'
    const after = '{!moteConversation && <span className="mobile-session-title">{sessionTitle ?? objectIdentity.name}</span>}'
    if (code.split(before).length !== 2) throw new Error('Original Mote title marker absent from loaded MobileApp')
    return code.replace(before, after)
  }
}] })
