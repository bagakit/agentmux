// Private verifier supervisor. Product operations use the installed public Core/CLI.
import fs from 'node:fs/promises';
import os from 'node:os';
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
const slowReaders = new Map();
async function stopReader(reader) {
    if (reader.exitCode !== null || reader.signalCode !== null) return;
    const ended = once(reader, 'exit');
    reader.kill('SIGCONT'); reader.kill('SIGTERM'); await ended;
}
async function sampleProcesses(pids) {
    assert(Array.isArray(pids) && pids.length && pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    const observedAt = Date.now();
    const {stdout} = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,time=,rss=,comm=']);
    const rows = stdout.split('\n').flatMap(line => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) return [];
        const parts=m[3].split(':').map(Number); let cpuSeconds=0; for(const n of parts) cpuSeconds=cpuSeconds*60+n;
        return [{pid:Number(m[1]),ppid:Number(m[2]),cpuSeconds,rssKiB:Number(m[4]),command:m[5]}];
    });
    const owned = new Set(pids); let changed=true;
    while(changed) { changed=false; for(const row of rows) if(owned.has(row.ppid)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;} }
    const processes=rows.filter(row=>owned.has(row.pid));
    assert(pids.every(pid=>processes.some(row=>row.pid===pid)), 'A sampled original process is missing');
    let sockets;
    if(process.platform==='linux') {
        try {
            const inodeOwners=new Map();
            for(const proc of processes) for(const fd of await fs.readdir('/proc/'+proc.pid+'/fd')) {
                const link=await fs.readlink('/proc/'+proc.pid+'/fd/'+fd),m=/^socket:\[(\d+)\]$/.exec(link??'');
                if(m) { const owners=inodeOwners.get(m[1])??[];owners.push(proc.pid);inodeOwners.set(m[1],owners); }
            }
            const tcp=[];
            for(const family of ['tcp','tcp6']) { const data=await fs.readFile('/proc/net/'+family,'utf8');
                for(const line of data.trim().split('\n').slice(1)){const fields=line.trim().split(/\s+/);if(inodeOwners.has(fields[9]))tcp.push({family,state:fields[3],inode:fields[9],pids:inodeOwners.get(fields[9])});}
            }
            sockets={kind:'linux-proc-owned-socket-inodes',socketInodes:inodeOwners.size,establishedTcp:tcp.filter(row=>row.state==='01').length,tcp};
        } catch(error) { sockets={kind:'unknown',reason:String(error),code:error.code,pids:processes.map(proc=>proc.pid)}; }
    } else {
        try { const result=await promisify(execFile)('/usr/sbin/lsof',['-nP','-a','-p',processes.map(row=>row.pid).join(','),'-iTCP','-FpnT']);
            if(result.stderr) throw Error(result.stderr);
            sockets={kind:'lsof-exact-owned-pids',establishedTcp:(result.stdout.match(/TST=ESTABLISHED/g)??[]).length,raw:result.stdout};
        } catch(error) { sockets={kind:'unknown',reason:String(error)}; }
    }
    return {observedAt,processes,sockets,host:{platform:process.platform,architecture:process.arch,cpuModel:os.cpus()[0]?.model,cpuCount:os.cpus().length,totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),uptimeSeconds:os.uptime(),loadAverage:os.loadavg()}};
}
const stop = async () => { if (stopped)
    return; stopped = true; const errors = []; for(const reader of slowReaders.values()) await stopReader(reader).catch(error=>errors.push(String(error))); if (pausedTransport) {
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
        else if (request.action === 'sample-processes') {
            result = await sampleProcesses(request.pids);
        }
        else if (request.action === 'start-slow-reader') {
            assert(typeof request.runId === 'string' && request.runId.length>0);
            const readerCode = `import {connectAgentMuxRpc} from ${JSON.stringify(pathToFileURL(join(packageRoot,'dist/public-rpc-client.js')).href)};import {connectHostedAgentMux} from ${JSON.stringify(pathToFileURL(join(packageRoot,'dist/hosted-client.js')).href)};const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:${JSON.stringify(receipt.socketPath)}}});const client=await connectHostedAgentMux({rpc});await client.connectRuntime();client.onRunEvent(${JSON.stringify(request.runId)},()=>{}, {observeMessages:false});const attached=await client.attachTerminal(${JSON.stringify(request.runId)},0,'raw');console.log(JSON.stringify({runId:attached.run.runId}));process.once('SIGTERM',()=>void client.dispose().then(()=>rpc.dispose()).then(()=>process.exit(0)));`;
            const reader=spawn(nodePath,['--input-type=module','-e',readerCode],{env,stdio:['ignore','pipe','pipe']});
            slowReaders.set(reader.pid,reader); reader.stderr.pipe(createWriteStream(join(base,'reader-'+reader.pid+'.stderr')));
            const lines=createInterface({input:reader.stdout});
            const [line]=await Promise.race([once(lines,'line'),once(reader,'exit').then(()=>{throw Error('Private reader exited before ready')})]);
            assert.equal(JSON.parse(line).runId,request.runId);reader.kill('SIGSTOP');
            const state=await promisify(execFile)('ps',['-p',String(reader.pid),'-o','stat=']);
            assert(state.stdout.includes('T'),'Exact private reader is not stopped');
            result={pid:reader.pid,runId:request.runId,state:state.stdout.trim(),startedAt:Date.now()};
        }
        else if(request.action==='stop-slow-reader') {
            const reader=slowReaders.get(request.pid);assert(reader,'Unknown original private reader');
            await stopReader(reader);slowReaders.delete(request.pid);result={pid:request.pid,exitCode:reader.exitCode,signal:reader.signalCode};
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
