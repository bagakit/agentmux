import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const controlModule = fileURLToPath(new URL('../dist/control-host.js', import.meta.url))

// Run the built server in its own process: an unhandled socket error must fail this
// test as a process exit, not be swallowed by a test-runner error listener.
describe('Control socket error lifetime', () => {
  it.each(['late-success', 'late-error', 'during-execution'])(
    'survives %s and still serves the next client without replaying the operation',
    async (scenario) => {
      const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { once } from 'node:events';
        import { mkdtemp, rm } from 'node:fs/promises';
        import { createConnection } from 'node:net';
        import { join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const { AgentMuxControlServer, requestAgentMuxControl } = await import(pathToFileURL(process.argv[1]));
        const { AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(new URL('./control.js', pathToFileURL(process.argv[1])));
        const scenario = process.argv[2];
        const root = await mkdtemp('/private/tmp/amx-epipe-');
        const path = join(root, 'control.sock');
        const entered = Promise.withResolvers();
        const finish = Promise.withResolvers();
        let executions = 0;
        const server = new AgentMuxControlServer({
          async execute(request) {
            executions++;
            if (request.requestId === 'abandoned') {
              entered.resolve();
              await finish.promise;
              if (scenario === 'late-error') throw new Error('Operation failed');
            }
            return { operation: 'list.agents', agents: [] };
          }
        }, path);
        let peer;
        try {
          await server.start();
          // Observe the real accepted socket only to synchronize peer FIN / inject
          // an OS-style async failure. No replacement transport or error catcher.
          const accepted = once(server.server, 'connection');
          peer = createConnection(path);
          peer.on('error', () => {});
          const [socket] = await accepted;
          const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'abandoned', operation: 'list.agents' };
          peer.write(JSON.stringify(request) + '\\n');
          await entered.promise;
          if (scenario === 'during-execution') {
            const closed = new Promise(resolve => socket.once('close', resolve));
            socket.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
            await closed;
          } else {
            const ended = once(socket, 'end');
            peer.destroy();
            await ended;
            assert.equal(socket.destroyed, false, 'Must exercise the writable half-open reply race');
          }
          const closed = socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve));
          finish.resolve();
          await closed;
          const receipt = await requestAgentMuxControl({ ...request, requestId: 'next-client' }, path);
          assert.equal(receipt.ok, true);
          assert.equal(receipt.requestId, 'next-client');
          assert.equal(executions, 2, 'A failed reply must never replay the operation');
          console.log('control-server-survived');
        } finally {
          peer?.destroy();
          finish.resolve();
          await server.stop();
          await rm(root, { recursive: true, force: true });
        }
      `, controlModule, scenario], { timeout: 10_000 })
      expect(stdout.trim()).toBe('control-server-survived')
    },
    15_000
  )
})
