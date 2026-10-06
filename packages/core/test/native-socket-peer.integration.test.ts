import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, realpath, rm, rename } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { openNativeSocketChannel } from '../dist/agent-native-socket.js'

// Real OS processes/connections. This fixture proves the reusable socket primitive,
// not vendor Native admission or a current conversation identity.
it.each(['same-fd-rpc', 'original-detached', 'endpoint-replaced'] as const)('kernel-bound Native socket: %s', async scenario => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-peer-'))), endpoint = join(root, 'rpc.sock')
  const server = createServer(), wss = new WebSocketServer({ server })
  wss.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(String(bytes))
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { peerPid: process.pid, method: request.method } }))
  }))
  server.listen(endpoint); await once(server, 'listening'); await chmod(endpoint, 0o600)
  const wsPath = createRequire(import.meta.url).resolve('ws')
  const child = spawn(process.execPath, ['-e', `const WS=require(${JSON.stringify(wsPath)}),net=require('net');
    const ws=new WS('ws://localhost/',{createConnection:()=>net.connect(${JSON.stringify(endpoint)})});
    ws.on('open',()=>console.log('ready'));ws.on('error',()=>process.exit(2));setInterval(()=>{},1000);
    process.stdin.on('data',()=>{ws.close();console.log('detached')});`], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let channel: Awaited<ReturnType<typeof openNativeSocketChannel>> | undefined
  try {
    await once(child.stdout!, 'data')
    channel = await openNativeSocketChannel(child.pid!, endpoint, AbortSignal.timeout(4000))
    expect(channel.binding).toMatchObject({ runPid: child.pid, tuiPid: child.pid, peerPid: process.pid, endpoint })
    await channel.assertCurrent(AbortSignal.timeout(4000))
    expect((await channel.request('read', {})).result).toEqual({ peerPid: process.pid, method: 'read' })
    if (scenario === 'original-detached') {
      const observed = once(child.stdout!, 'data'); child.stdin!.write('detach'); await observed
      await expect(channel.assertCurrent(AbortSignal.timeout(4000))).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNCONFIRMED' })
      // The peer and this new RPC connection still work; they cannot substitute
      // for the original TUI association that was just lost.
      expect((await channel.request('read', {})).result).toEqual({ peerPid: process.pid, method: 'read' })
      expect(child.exitCode).toBeNull()
    } else if (scenario === 'endpoint-replaced') {
      await rename(endpoint, join(root, 'old.sock'))
      const replacement = createServer(); replacement.listen(endpoint); await once(replacement, 'listening'); await chmod(endpoint, 0o600)
      try { await expect(channel.assertCurrent(AbortSignal.timeout(4000))).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNCONFIRMED' }) }
      finally { replacement.close() }
    }
  } finally {
    if (channel) await channel.close()
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    for (const socket of wss.clients) socket.terminate()
    wss.close(); server.close(); await rm(root, { recursive: true, force: true })
  }
}, 15_000)
