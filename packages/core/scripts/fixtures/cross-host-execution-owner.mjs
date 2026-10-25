// Private verifier supervisor. Product operations use the installed public Core/CLI.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
const cfg = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const { base, packageRoot, nodePath, codexPath, modelPort, remote } = cfg;
assert(/^[a-f0-9]{40}$/.test(cfg.expectedSourceCommit), 'An exact candidate is required');
for (const value of [base, packageRoot, nodePath, codexPath])
    assert(typeof value === 'string' && value.startsWith('/') && !/[\0\r\n]/.test(value));
const profileBase = cfg.profileBase ?? base;
await fs.mkdir(base, { recursive: true, mode: 0o700 });
// Re-running an old owner input cannot adopt or overwrite its saved state.
for (const dir of ['runtime', 'state'])
    await fs.mkdir(join(base, dir), { mode: 0o700 });
if (profileBase !== base)
    await fs.mkdir(profileBase, { mode: 0o700 });
for (const dir of ['home', 'codex'])
    await fs.mkdir(join(profileBase, dir), { mode: 0o700 });
await fs.mkdir(join(base, 'workspace'), { mode: 0o700 });
const env = { PATH: codexPath + ':' + nodePath.substring(0, nodePath.lastIndexOf('/')) + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(profileBase, 'home'), CODEX_HOME: join(profileBase, 'codex'), SHELL: '/bin/bash', USER: process.env.USER || 'test', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', AGENTMUX_RUNTIME_DIRECTORY: join(base, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(base, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(base, 'state', 'sessions.json'), ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) };
await fs.writeFile(join(profileBase, 'codex', 'config.toml'), `cli_auth_credentials_store = "file"\nmodel = "gpt-5.4"\nmodel_provider = "offline"\n[model_providers.offline]\nname = "Two-host controlled native proof"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`, { mode: 0o600 });
const version = await promisify(execFile)(join(codexPath, 'codex'), ['--version'], { env, timeout: 10000 });
assert.equal(version.stdout.trim(), 'codex-cli 0.165.0');
assert.equal(version.stderr, '');
const native = spawn(join(packageRoot, 'vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'), ['--socket', join(base, 'runtime/ctxmux.sock'), '--state-dir', join(base, 'state/ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
native.stderr.pipe(createWriteStream(join(base, 'native.stderr')));
await Promise.race([once(native.stdio[3], 'data'), once(native, 'exit').then(() => { throw Error('Native exited before readiness'); })]);
const runner = `import {startHeadlessAgentMux} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/headless-runtime.js')).href)};import {connectAgentMuxRpc} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/public-rpc-client.js')).href)};import {connectHostedAgentMux} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/hosted-client.js')).href)};let rpc,peer;const remote=${JSON.stringify(remote || null)};if(remote){rpc=await connectAgentMuxRpc({endpoint:remote});peer=await connectHostedAgentMux({rpc});await peer.connectRuntime();}const owner=await startHeadlessAgentMux({coreClients:()=>peer?[{hostId:'remote',client:peer}]:[]});console.log(JSON.stringify({socketPath:owner.socketPath,owner:owner.ownerIdentity()}));const stop=()=>void owner.stop().then(async()=>{await peer?.dispose();await rpc?.dispose();process.exit(0)});process.once('SIGTERM',stop);`;
let core, receipt, coreEpoch = 0;
async function startCore() {
    core = spawn(nodePath, ['--input-type=module', '-e', runner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    core.stderr.pipe(createWriteStream(join(base, 'core-' + coreEpoch + '.stderr')));
    coreEpoch++;
    const lines = createInterface({ input: core.stdout });
    const [line] = await Promise.race([once(lines, 'line'), once(core, 'exit').then(() => { throw Error('Core exited before readiness'); })]);
    receipt = { ...JSON.parse(line), base, profileBase, platform: process.platform, arch: process.arch, node: process.version, nativeVersion: version.stdout.trim(), candidateCommit: cfg.expectedSourceCommit, corePid: core.pid, nativePid: native.pid };
    await fs.writeFile(join(base, 'owner.json'), JSON.stringify(receipt, null, 2));
    return receipt;
}
try {
    process.stdout.write(JSON.stringify(await startCore()) + '\n');
}
catch (error) {
    for (const child of [core, native])
        if (child && child.exitCode === null && child.signalCode === null) {
            const ended = once(child, 'exit');
            child.kill('SIGTERM');
            await ended;
        }
    throw error;
}
const { connectAgentMuxRpc } = await import(pathToFileURL(join(packageRoot, 'dist/public-rpc-client.js')));
const { connectHostedAgentMux } = await import(pathToFileURL(join(packageRoot, 'dist/hosted-client.js')));
let stopped = false, pausedTransport;
const stop = async () => { if (stopped)
    return; stopped = true; const errors = []; if (pausedTransport) {
    try {
        process.kill(pausedTransport.pid, 'SIGKILL');
    }
    catch (e) {
        if (e.code !== 'ESRCH')
            errors.push(String(e));
    }
    pausedTransport = undefined;
} let rpc, client; try {
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: receipt.socketPath } });
    client = await connectHostedAgentMux({ rpc });
    await client.connectRuntime();
    assert.equal(client.runtimeOwnerIdentity().runtimeId, receipt.owner.runtimeId, 'Cleanup cannot change original semantic owner');
    for (const run of await client.listRuns()) {
        if (run.state === 'running')
            try {
                await client.stopTerminal({ runId: run.runId });
            }
            catch (e) {
                errors.push(String(e));
            }
    }
}
catch (e) {
    errors.push(String(e));
} await client?.dispose(); await rpc?.dispose(); for (const child of [core, native])
    if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGTERM');
        await ended;
    } await fs.writeFile(join(base, 'cleanup.json'), JSON.stringify({ errors })); process.stdout.write(JSON.stringify({ stopped: true, errors }) + '\n'); process.exit(errors.length ? 1 : 0); };
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
let queue = Promise.resolve();
const control = createInterface({ input: process.stdin });
control.on('line', line => {
    queue = queue.then(async () => {
        if (line === 'stop') {
            await stop();
            return;
        }
        const request = JSON.parse(line);
        let result;
        if (request.action === 'restart-core') {
            const oldPid = core.pid, ended = once(core, 'exit');
            core.kill('SIGTERM');
            const [code, signal] = await ended;
            if (code !== 0 || signal !== null)
                throw Error('Original test Core exit was not clean');
            result = { oldPid, exitCode: code, exitSignal: signal, receipt: await startCore() };
        }
        else if (request.action === 'drop-transport' || request.action === 'pause-transport') {
            if (!remote)
                throw Error('This test owner has no remote transport');
            const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,command=']);
            const children = stdout.split('\n').flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m && Number(m[2]) === core.pid && /^ssh(?:\s|$)/.test(m[3]) && m[3].includes(remote.command) && m[3].includes(remote.socketPath) ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []; });
            if (children.length !== 1)
                throw Error('The exact coordinator SSH child is not uniquely identified');
            const signal = request.action === 'pause-transport' ? 'SIGSTOP' : pausedTransport ? 'SIGKILL' : 'SIGTERM';
            if (pausedTransport && pausedTransport.pid !== children[0].pid)
                throw Error('The original paused SSH child changed');
            process.kill(children[0].pid, signal);
            pausedTransport = request.action === 'pause-transport' ? children[0] : undefined;
            result = { cut: children[0], signal, corePid: core.pid, nativePid: native.pid, at: Date.now() };
        }
        else
            throw Error('Unknown private owner control');
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    }).catch(error => { process.stdout.write(JSON.stringify({ error: String(error) }) + '\n'); });
});
