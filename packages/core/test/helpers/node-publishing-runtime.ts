import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { AgentMuxRuntimeOwnerIdentity } from '../../src/hosted-client-contract.js';
import type { AgentMuxRpcClient } from '../../src/public-rpc-client.js';
export async function nodeRuntimeFixture(peer?: {
    socketPath: string;
    owner: AgentMuxRuntimeOwnerIdentity;
}, desktopStyle = false, core = process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT!, worker = resolve(import.meta.dirname, '../fixtures/node-publishing-core.mjs')) {
    if(!core) throw Error('Exact private candidate Core required');
    const root = await mkdtemp('/tmp/nnp-core-'), runtimeDirectory = join(root, 'r'), stateDirectory = join(root, 's');
    await Promise.all([mkdir(runtimeDirectory, { mode: 0o700 }), mkdir(join(stateDirectory, 'ctxmux'), { recursive: true, mode: 0o700 }), mkdir(join(root, 'home'), { mode: 0o700 })]);
    const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMUX_') && !k.startsWith('CTXMUX_'))), HOME: join(root, 'home'), NODE_PUBLICATION_TEST_CORE: core, NODE_PUBLICATION_TEST_DESKTOP_ROUTE: desktopStyle ? '1' : '0',
        AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: stateDirectory, AGENTMUX_AGENT_SESSION_STORE: join(stateDirectory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(stateDirectory, 'messages.ndjson'),
        ...(peer ? { NODE_PUBLICATION_TEST_PEER: peer.socketPath, NODE_PUBLICATION_TEST_PEER_RUNTIME: peer.owner.runtimeId } : {}) };
    const { connectAgentMuxRpc } = await import(/* @vite-ignore */ pathToFileURL(join(core, 'dist/public-rpc-client.js')).href) as typeof import('../../src/public-rpc-client.js');
    const stop = async (child: ChildProcess) => { if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
    } };
    const daemon = spawn(join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'), ['--socket', join(runtimeDirectory, 'ctxmux.sock'), '--state-dir', join(stateDirectory, 'ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let errors = '';
    daemon.stderr!.on('data', b => errors += String(b));
    let server: ChildProcess | undefined, current: {
        owner: AgentMuxRuntimeOwnerIdentity;
        socketPath: string;
    };
    const connections: AgentMuxRpcClient[] = [];
    try {
        await new Promise<void>((yes, no) => { const timer = setTimeout(() => no(Error('Private Native readiness timeout: ' + errors)), 20000); daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes(); }); daemon.once('error', e => { clearTimeout(timer); no(e); }); daemon.once('exit', code => { clearTimeout(timer); no(Error('Private Native exited ' + code + ': ' + errors)); }); });
        const launch = async () => {
            server = spawn(process.execPath, [worker], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            const child = server;
            let stdout = '', stderr = '';
            return await new Promise<typeof current>((yes, no) => { const timer = setTimeout(() => no(Error('Private Core readiness timeout: ' + stderr)), 20000); child.stderr!.on('data', b => stderr += String(b)); child.stdout!.on('data', b => { stdout += String(b); if (stdout.includes('\n')) {
                clearTimeout(timer);
                try {
                    yes(JSON.parse(stdout.split('\n')[0]!));
                }
                catch (e) {
                    no(e);
                }
            } }); child.once('error', e => { clearTimeout(timer); no(e); }); child.once('exit', code => { clearTimeout(timer); no(Error('Private Core exited ' + code + ': ' + stderr)); }); });
        };
        current = await launch();
        const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: current.socketPath } });
        connections.push(rpc);
        const deadline = Date.now() + 20000;
        while (!(await rpc.call('runtime.owner.identity', {})).owner.ctxmux) {
            if (Date.now() > deadline)
                throw Error('Private Native did not become visible');
            await new Promise(r => setTimeout(r, 20));
        }
        return { root, env, rpc, stateDirectory, nativePid: daemon.pid, get owner() { return current.owner; }, get socketPath() { return current.socketPath; },
            async restart() { await stop(server!); current = await launch(); return current.owner; },
            async cli(args: string[], input?: unknown) { return await new Promise<{
                code: number;
                stdout: string;
                stderr: string;
                value: any;
            }>(yes => { const child = execFile(process.execPath, [join(core, 'dist/agentmux.js'), '--endpoint', 'unix:' + current.socketPath, ...args], { env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => { let value; try {
                value = JSON.parse(stdout);
            }
            catch { } ; yes({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr, value }); }); child.stdin!.end(input === undefined ? '' : JSON.stringify(input)); }); },
            async cleanup() { for (const connection of connections)
                await connection.dispose(); await stop(server!); await stop(daemon); await rm(root, { recursive: true, force: true }); } };
    }
    catch (error) {
        if (server)
            await stop(server);
        await stop(daemon);
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
