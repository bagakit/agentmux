import type { ConnectionSetupAdapter } from '../../connection-setup-adapter.js'
import { advanceFeishuSession, FEISHU_QR_HEADERS } from './setup-session.js'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020\u007f]/u.test(value)
}
/** Reference-native Feishu authentication; no Lark or app-management eligibility is inferred. */
export function createFeishuSetup(): ConnectionSetupAdapter {
  return {
    domains: ['open.feishu.cn'],
    async begin(input, signal) {
      if (input.application.domain !== 'open.feishu.cn') return { kind: 'unknown' }
      try {
        const response = await fetch('https://accounts.feishu.cn/accounts/qrlogin/init', {
          method: 'POST', redirect: 'manual', ...(signal ? { signal } : {}),
          headers: FEISHU_QR_HEADERS,
          body: JSON.stringify({ biz_type: null, redirect_uri: 'https://ask.feishu.cn/' })
        })
        if (!response.ok || response.status >= 300) return { kind: 'unknown' }
        const body = record(await response.json()), data = record(body?.data), step = record(data?.step_info)
        const flowKey = response.headers.get('x-flow-key')
        if (body?.code !== 0 || !token(step?.token) || !token(flowKey)) return { kind: 'unknown' }
        const challenge = { qrPayload: JSON.stringify({ qrlogin: { token: step.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 }
        // Opaque original response evidence only. This slice neither parses nor sends cookies.
        const privateState = JSON.stringify({ version: 1, ...input, flowKey, token: step.token, setCookies: response.headers.getSetCookie() })
        return { kind: 'challenge', challenge, privateState }
      } catch { return { kind: 'unknown' } }
    },
    advance: advanceFeishuSession
  }
}
