import { createServer } from 'node:http'
/** Official SDK request/response encoding crosses a real HTTP boundary; only the native origin is controlled. */
export async function profileLoopback(read: (url: URL) => unknown | Promise<unknown>) {
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://native'); calls.push(url.pathname)
    try { const body = await read(url); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    catch { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  return { origin, calls, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
