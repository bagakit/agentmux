import { createHash, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const extensionFixtureId = key => createHash('sha256').update(key).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))
/** A real developer CRX3 proof; fixture callers provide the exact ZIP and key, never a trusted publisher. */
export function signExtensionFixtureCrx(pair, zip) {
  const integer = n => { const out = []; do { const value = n % 128; n = Math.floor(n / 128); out.push(value | (n ? 128 : 0)) } while (n); return Buffer.from(out) }
  const field = (n, bytes) => Buffer.concat([integer(n * 8 + 2), integer(bytes.length), bytes])
  const key = pair.publicKey.export({ type: 'spki', format: 'der' }), signed = field(1, createHash('sha256').update(key).digest().subarray(0, 16)), size = Buffer.alloc(4); size.writeUInt32LE(signed.length)
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signed, zip]), pair.privateKey)
  const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, signature)])), field(10000, signed)]), lead = Buffer.alloc(12)
  lead.write('Cr24'); lead.writeUInt32LE(3, 4); lead.writeUInt32LE(header.length, 8); return Buffer.concat([lead, header, zip])
}
/** Shared by bounded Native and full-App scenarios. Only their private children trust this CA. */
export async function startExtensionHttpsFixture(home, out) {
  const directory = join(home, 'online'), caPath = join(home, 'fixture-ca.pem'), requests = []
  await mkdir(directory, { recursive: true })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', join(home, 'fixture-key.pem'), '-out', caPath, '-subj', '/CN=Private extension acquisition fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  const certificate = await readFile(caPath); await writeFile(join(out, 'fixture-ca.pem'), certificate)
  const files = new Map(Object.entries({ '/package.zip': 'package.zip', '/signed.crx': 'signed.crx', '/signed.xml': 'signed.xml', '/webextensions.json': 'webextensions.json', '/webextension.xpi': 'webextension.xpi', '/unknown.zip': 'unknown.zip' }))
  let slow, remaining, closed = false, released = false
  const server = createServer({ key: await readFile(join(home, 'fixture-key.pem')), cert: certificate }, async (request, response) => {
    const path = new URL(request.url, 'https://127.0.0.1').pathname
    requests.push({ path, method: request.method, cookiePresent: !!request.headers.cookie, authorizationPresent: !!request.headers.authorization })
    if (path === '/slow-state') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ started: !!slow, open: !!slow && !closed && !released })); return }
    if (path === '/release-slow') { released = true; if (slow && !closed) slow.end(remaining); response.end('{}'); return }
    if (path === '/failure') { response.writeHead(503); response.end(); return }
    try {
      if (path === '/slow.zip') {
        const bytes = await readFile(join(directory, 'package.zip')); slow = response; remaining = bytes.subarray(1)
        response.on('close', () => { closed = true }); response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' }); response.write(bytes.subarray(0, 1)); return
      }
      const name = files.get(path)
      if (!name) { response.writeHead(404); response.end(); return }
      const bytes = await readFile(join(directory, name))
      response.writeHead(200, { 'Content-Type': path.endsWith('.xml') ? 'application/xml' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream' }); response.end(bytes)
    } catch { response.destroy() }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { origin: 'https://127.0.0.1:' + server.address().port, caPath, requests, certificateSha256: createHash('sha256').update(certificate).digest('hex'),
    async publish(path, bytes) { const name = files.get(path) ?? encodeURIComponent(path); files.set(path, name); await writeFile(join(directory, name), bytes) },
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)) } }
}
