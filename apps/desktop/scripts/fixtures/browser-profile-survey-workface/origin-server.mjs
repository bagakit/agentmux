import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Real HTTP form sign-in and two origins, shared by the same native producer. */
export async function startProfileSurveyOrigins() {
  const requests = []
  const servers = []
  let primaryOrigin, secondaryOrigin
  const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  const identity = request => {
    const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('amux-survey-login='))?.slice('amux-survey-login='.length)
    try { return token === undefined ? null : decodeURIComponent(token) } catch { return null }
  }
  const artifactFor = user => {
    const bytes = Buffer.from('Original Profile workface result\nSigned in as: ' + (user ?? 'signed-out') + '\n')
    return { filename: 'profile-workface-result.txt', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const html = (response, title, body) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>' + escape(title) + '</title><style>body{font:16px system-ui;margin:32px;color:#19342b;background:#f3f7f4}input,button,a{font:inherit;margin:8px;padding:10px}label{display:block}</style>' + body)
  }
  const handler = async (request, response) => {
    const url = new URL(request.url, primaryOrigin), user = identity(request)
    requests.push({ origin: 'http://' + request.headers.host, method: request.method, path: url.pathname, user })
    if (url.pathname === '/login' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk.toString('utf8')
      const submitted = new URLSearchParams(body).get('user') ?? ''
      response.writeHead(303, { location: '/work', 'set-cookie': 'amux-survey-login=' + encodeURIComponent(submitted) + '; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax', 'cache-control': 'no-store' })
      response.end(); return
    }
    if (url.pathname === '/identity') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ user })); return
    }
    if (url.pathname === '/download') {
      const artifact = artifactFor(user)
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="' + artifact.filename + '"', 'content-length': artifact.bytes.length, 'cache-control': 'no-store' })
      response.end(artifact.bytes); return
    }
    if (url.pathname === '/context-menu') {
      html(response, 'Context actions', '<label>Page draft<input aria-label="Page draft"></label><p><a id="main-link" href="/work?context=main#main-target">Open from main document</a></p><iframe id="context-frame" src="/context-frame" title="Embedded document" style="width:400px;height:160px;border:0"></iframe>' +
        '<div><a href="/work?context=image#image-target"><img id="linked-image" width="88" height="36" src="/context-image.png" alt="Linked image"></a></div>' +
        '<p id="selected-text">Selected original text</p><video id="context-video" width="128" height="80" preload="auto" muted src="/context-video.webm"></video>' +
        '<p id="page-background" style="user-select:none">Plain page background</p>'); return
    }
    if (url.pathname === '/context-image.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQSA7/DwADewHiU1yAfAAAAABJRU5ErkJggg==', 'base64')); return
    }
    if (url.pathname === '/context-video.webm') {
      response.writeHead(200, { 'content-type': 'video/webm' })
      response.end(await readFile(new URL('./context-video.webm', import.meta.url))); return
    }
    if (url.pathname === '/context-frame') {
      html(response, 'Embedded actions', '<a id="frame-link" href="/work?context=frame&amp;exact=1#frame-target">Open from embedded document</a><p id="frame-background" style="user-select:none">Embedded document background</p>'); return
    }
    if (url.pathname === '/context-media-frame') {
      html(response, 'Embedded video', '<style>body{margin:0}</style><video width="128" height="80" preload="auto" muted src="/context-video.webm"></video>'); return
    }
    if (url.pathname === '/field-guide') {
      html(response, 'Field Guide', '<h1>Field Guide</h1><p>Saved destination for the original address input.</p>'); return
    }
    if (url.pathname === '/work' || url.pathname === '/child') {
      html(response, url.pathname === '/child' ? 'Related page' : 'Profile workface', '<h1>Website workface</h1><p>Signed in as <output id="identity">' + escape(user ?? 'signed-out') + '</output></p><label>Page draft<input aria-label="Page draft" value="Keep this original page input"></label><a target="_blank" href="' + secondaryOrigin + '/child">Open related page</a><a href="' + primaryOrigin + '/download">Download result</a>'); return
    }
    html(response, 'Website sign-in', '<h1>Website sign-in</h1><form action="/login" method="post"><label>Account<input name="user" aria-label="Account" autocomplete="off"></label><button type="submit">Sign in</button></form>')
  }
  try {
    for (let index = 0; index < 2; index++) {
      const server = createServer((request, response) => { void handler(request, response).catch(error => { response.writeHead(500); response.end(String(error)) }) })
      servers.push(server)
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    }
    primaryOrigin = 'http://127.0.0.1:' + servers[0].address().port
    secondaryOrigin = 'http://127.0.0.1:' + servers[1].address().port
    return {
      primaryOrigin, secondaryOrigin, pageUrl: primaryOrigin + '/work', loginUrl: primaryOrigin + '/login',
      identityUrl: primaryOrigin + '/identity', childUrl: secondaryOrigin + '/child', downloadUrl: primaryOrigin + '/download',
      requests, artifactFor,
      async close() { await Promise.all(servers.map(server => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }))) }
    }
  } catch (error) {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })))
    throw error
  }
}
