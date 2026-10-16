/** Synthetic issuer responses at the HTTP boundary; original Enrollment owns every transition and claim. */
export function moteEnrollmentWeb(options: { appId?(index: number): string; observe?(target: URL, input: RequestInit): void } = {}) {
  const calls: Array<{ target: URL; input: RequestInit }> = []
  let begins = 0, authentications = 0, creates = 0
  const fetch = async (url: string | URL | Request, input: RequestInit = {}) => {
    const target = new URL(url instanceof Request ? url.url : String(url)), headers = new Headers(input.headers)
    calls.push({ target, input }); options.observe?.(target, input)
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init') {
      const index = ++begins
      const response = Response.json({ code: 0, data: { step_info: { token: 'private-mote-qr-' + index } } }, { headers: { 'x-flow-key': 'private-mote-flow-' + index } })
      // This is a Node HTTP response consumed by Main; DOM Response constructors strip Set-Cookie.
      response.headers.append('set-cookie', `mote-session=${index}; Domain=.feishu.cn; Path=/; Secure; HttpOnly`)
      return response
    }
    const index = Number(headers.get('cookie')?.match(/(?:^|;\s*)mote-session=([0-9]+)/u)?.[1])
    if (!index) throw new Error('The original private session cookie is missing')
    if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling') { authentications++; return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } }) }
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not an identity assertion')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: 'mote-user-' + index, tenantId: 'mote-tenant', name: 'Original account', tenantName: 'Original enterprise' })};window.csrfToken=${JSON.stringify('private-mote-csrf-' + index)};</script>`, { headers: { 'content-type': 'text/html' } })
    if (target.origin !== 'https://open.feishu.cn' || input.method !== 'POST' || headers.get('x-csrf-token') !== 'private-mote-csrf-' + index) throw new Error('Unqualified original console request')
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.invalid/mote-' + index + '.png' } })
    const appId = options.appId?.(index) ?? 'cli_mote_' + index
    if (target.pathname === '/developers/v1/manifest/upsert_by_template') { creates++; return Response.json({ code: 0, data: { ClientID: appId } }) }
    if (target.pathname === '/developers/v1/secret/' + appId) return Response.json({ code: 0, data: { secret: 'private-original-secret' } })
    throw new Error('Unexpected native creation request')
  }
  return { fetch, calls, get begins() { return begins }, get authentications() { return authentications }, get creates() { return creates } }
}
