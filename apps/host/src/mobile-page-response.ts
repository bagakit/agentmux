import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMobileBuildId } from '@agentmux/core/mobile-web-codec'

/** Entry navigation is separate from the immutable scripts and styles it loads. */
export function isMobilePageEntry(path: string): boolean {
  if (path === '/' || path === '/index.html') return true
  const segment = /^\/mobile\/([^/]+)\/[a-f0-9]{64}\/index\.html$/u.exec(path)?.[1]
  if (!segment) return false
  try {
    const buildId = decodeURIComponent(segment)
    return isMobileBuildId(buildId) && encodeURIComponent(buildId) === segment
  } catch { return false }
}

const recoveryScript = `document.getElementById('retry').addEventListener('click',()=>location.reload());document.getElementById('back').addEventListener('click',()=>{if(history.length>1)history.back();else document.getElementById('result').textContent='没有可返回的上一页，请稍后重试。'});`
const scriptHash = createHash('sha256').update(recoveryScript).digest('base64')
const recoveryPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>重新打开 AgentMux</title><style>
:root{color-scheme:light dark;font:14px/1.6 system-ui,sans-serif;color:#26362d;background:#f4f7f4}body{margin:0;padding:24px;min-height:100svh;box-sizing:border-box;display:grid;place-items:center}main{width:min(100%,360px)}h1{font-size:20px;line-height:1.4;margin:0 0 12px}p{margin:12px 0}.actions{display:flex;flex-wrap:wrap;gap:12px}button{min-height:44px;padding:8px 16px;font:inherit;border:1px solid #718678;border-radius:10px;color:inherit;background:transparent;cursor:pointer}button:first-child{color:#216740;border-color:currentColor}button:focus-visible{outline:2px solid #32794c;outline-offset:3px}#result{font-size:13px}@media(prefers-color-scheme:dark){:root{color:#edf1ee;background:#111419}button{border-color:#728578}button:first-child{color:#8de3ae}button:focus-visible{outline-color:#8de3ae}}
</style><main><h1>网页暂时无法打开</h1><p>当前服务暂时无法提供网页，请稍后重试。</p><div class="actions"><button type="button" id="retry">重新尝试</button><button type="button" id="back">返回上一页</button></div><p id="result" role="status"></p></main><script>${recoveryScript}</script></html>`

/** Reload keeps the browser's original URL fragment and same-Tab handoff storage. */
export function mobilePageUnavailable(request: IncomingMessage, response: ServerResponse, status: 410 | 503): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(recoveryPage),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    ...(status === 503 ? { 'Retry-After': '1' } : { 'X-AgentMux-Mobile-Resource': 'not-retained' }),
  })
  response.end(request.method === 'HEAD' ? undefined : recoveryPage)
}

export function mobileResourceUnavailable(request: IncomingMessage, response: ServerResponse, status: 400 | 404 | 410 | 503): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 503 ? { 'Retry-After': '1' } : {}),
    ...(status === 410 ? { 'X-AgentMux-Mobile-Resource': 'not-retained' } : status === 404 ? { 'X-AgentMux-Mobile-Resource': 'unavailable' } : {}),
  })
  response.end(request.method === 'HEAD' ? undefined : 'Mobile resource unavailable. Reopen the original mobile entry.')
}
