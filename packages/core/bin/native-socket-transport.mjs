#!/usr/bin/env node
import { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'

// The Core OS observer execs this process with its already connected, verified FD.
// Socket({fd}) and ws.createConnection reuse that exact connection; no pathname reconnect.
const fd = Number(process.env.AGENTMUX_NATIVE_SOCKET_FD)
delete process.env.AGENTMUX_NATIVE_SOCKET_FD
if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('Native socket descriptor is absent')
const socket = new Socket({ fd, readable: true, writable: true })
const webSocket = new WebSocket('ws://localhost/', { createConnection: () => socket })
const write = value => process.stdout.write(JSON.stringify(value) + '\n')
const input = createInterface({ input: process.stdin })
let open = false
webSocket.on('open', () => { open = true; write({ type: 'native-socket-ready', schema: 1 }) })
webSocket.on('message', (bytes, binary) => {
  if (binary) { process.exitCode = 1; webSocket.terminate(); return }
  // Keep the native JSON-RPC frame unchanged. The Provider validates its protocol.
  process.stdout.write(bytes.toString('utf8') + '\n')
})
input.on('line', line => {
  if (!open) { process.exitCode = 1; webSocket.terminate(); return }
  const value = JSON.parse(line)
  webSocket.send(JSON.stringify(value))
})
input.on('close', () => webSocket.close())
webSocket.on('error', () => { process.exitCode = 1; input.close(); socket.destroy() })
webSocket.on('close', () => { input.close(); process.stdin.destroy() })
