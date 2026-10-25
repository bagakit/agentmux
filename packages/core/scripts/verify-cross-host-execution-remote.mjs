import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { join, dirname, basename, resolve, isAbsolute, normalize } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// Two physical Hosts, controlled model, installed public Core/CLI and real native tools.
// This script never installs/upgrades packages or uses an existing Core service.
// --receipt is the original target authorization plus one explicitly installed candidate;
// old execution evidence is not consumed as a current result. The default reader-gap mode
// includes native file/process work and original-session recovery before the transport gap.
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    if (flag === '--help' && process.argv.length === 3) {
        console.log('node verify-cross-host-execution-remote.mjs --receipt FILE [--mode native|recovery|reader-gap] [--direction both|remote-agent|local-agent]\nThe receipt must retain agentmux.cross-host-target-authorization.v1 and executionCandidate: {schema:"agentmux.cross-host-installed-candidate.v1", sourceCommit, scopeId, candidateReceipt, local:{packageRoot,nodePath,codexDirectory}, remote:{installedRoot,packageRoot,nodePath,codexDirectory,profileRoot,command,endpoint:{transport:"ssh",host,user?}}}. The installed root must contain .agentmux-cross-host-test-root.json with the same scopeId/sourceCommit/hostId/profileRoot/nodePath. No package installation or old success adoption occurs.');
        process.exit(0);
    }
    assert(['--receipt', '--mode', '--direction'].includes(flag) && !flags.has(flag) && process.argv[index + 1], 'Unknown, duplicate or incomplete verifier argument');
    flags.set(flag, process.argv[index + 1]);
}
assert(flags.has('--receipt'), 'An original target authorization receipt is required; no service was created');
const mode = flags.get('--mode') ?? 'reader-gap', direction = flags.get('--direction') ?? 'both';
assert(['native', 'recovery', 'reader-gap'].includes(mode), 'Unknown verification mode');
assert(['both', 'remote-agent', 'local-agent'].includes(direction), 'Unknown verification direction');
const receiptPath = resolve(flags.get('--receipt'));
const authorizationBytes = await fs.readFile(receiptPath);
const authorization = JSON.parse(authorizationBytes.toString());
assert.equal(authorization.schema, 'agentmux.cross-host-target-authorization.v1');
assert.equal(authorization.source?.role, 'user', 'The original user target authorization is absent');
for (const key of ['kind', 'answer', 'scope'])
    assert(typeof authorization.source[key] === 'string' && authorization.source[key].length > 0, 'The original authorization source is incomplete');
const candidate = authorization.executionCandidate;
assert.equal(candidate?.schema, 'agentmux.cross-host-installed-candidate.v1', 'One exact installed candidate is required; no package or service was changed');
assert(/^[a-f0-9]{40}$/.test(candidate.sourceCommit) && typeof candidate.scopeId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(candidate.scopeId), 'Candidate source and private scope identity are required');
const absolute = value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value) && normalize(value) === value;
for (const [side, keys] of [['local', ['packageRoot', 'nodePath', 'codexDirectory']], ['remote', ['installedRoot', 'packageRoot', 'nodePath', 'codexDirectory', 'profileRoot', 'command']]]) {
    assert(candidate[side] && keys.every(key => absolute(candidate[side][key])), `Exact absolute ${side} candidate paths are required`);
}
assert(absolute(candidate.candidateReceipt), 'The immutable local build receipt path is required');
const within = (base, target) => target.startsWith(base + '/');
assert(!['/', '/tmp', '/home', '/Users'].includes(candidate.remote.installedRoot), 'A private installed root is required');
for (const key of ['packageRoot', 'codexDirectory', 'command'])
    assert(within(candidate.remote.installedRoot, candidate.remote[key]), 'Remote runtime paths must stay inside the prepared private installation');
assert(candidate.remote.profileRoot !== candidate.remote.installedRoot && !['/', '/tmp', '/home', '/Users'].includes(candidate.remote.profileRoot), 'A separate prepared private Profile root is required');
const remoteEndpoint = candidate.remote.endpoint;
assert(remoteEndpoint?.transport === 'ssh' && typeof remoteEndpoint.host === 'string' && remoteEndpoint.host.length && !remoteEndpoint.host.startsWith('-') && !/[\s\0]/.test(remoteEndpoint.host));
assert(remoteEndpoint.user === undefined || typeof remoteEndpoint.user === 'string' && /^[a-zA-Z0-9_.-]+$/.test(remoteEndpoint.user));
const sshTarget = remoteEndpoint.user ? remoteEndpoint.user + '@' + remoteEndpoint.host : remoteEndpoint.host;
assert.equal(sshTarget, authorization.remote?.sshTarget, 'Candidate route differs from the original authorized target');
assert.equal(candidate.remote.nodePath, authorization.remote.verifiedNodePath, 'Remote Node differs from the verified target executable');
assert.equal(authorization.local?.platform, process.platform);
assert.equal(authorization.local?.architecture, process.arch);
assert.equal(await fs.realpath(candidate.local.nodePath), await fs.realpath(process.execPath), 'Run the verifier with the exact candidate Node');
const packageRoot = candidate.local.packageRoot, remoteRoot = candidate.remote.installedRoot, remotePackageRoot = candidate.remote.packageRoot, remoteNodePath = candidate.remote.nodePath, candidateCommit = candidate.sourceCommit;
const buildReceipt = JSON.parse(await fs.readFile(candidate.candidateReceipt, 'utf8'));
assert.equal(buildReceipt.sourceCommit, candidateCommit, 'Requested candidate differs from its original build receipt');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const criticalFiles = ['client.js', 'agent-execution-coordinator.js', 'agent-execution-bridge.js', 'agent-execution-journal.js',
    'agent-execution-executor.js', 'agent-execution-helper.js', 'agent-execution-protocol.js', 'agent-execution-channel.js',
    'headless-runtime.js', 'public-rpc-service.js', 'public-rpc-agent-execution.js', 'agent-native-process.js', 'ctxmux-run-adapter.js',
    'providers/app-server-native-session.js', 'providers/codex-execution-helper.js', 'providers/codex-execution-run.js',
    'providers/codex-execution-protocol.js', 'providers/codex-tool-execution-launch.js'];
// Earlier qualified candidates predate the Linux-specific observer module.
if (buildReceipt.compiledHashes?.['packages/core/dist/agent-native-process-linux.js']) criticalFiles.push('agent-native-process-linux.js');
const consumerHashes = Object.fromEntries(criticalFiles.map(file => {
    const digest = buildReceipt.compiledHashes?.['packages/core/dist/' + file];
    assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'Build receipt lacks consumer ' + file);
    return ['dist/' + file, digest];
}));
for (const [file, expected] of Object.entries(consumerHashes))
    assert.equal(sha256(await fs.readFile(join(packageRoot, file))), expected, 'Local installed consumer changed: ' + file);
assert(Array.isArray(buildReceipt.archives) && buildReceipt.archives.length > 0, 'Original published archive identities are absent');
const archives = buildReceipt.archives.map(archive => {
    assert(absolute(archive.file) && /^[a-f0-9]{64}$/.test(archive.sha256));
    return { file: basename(archive.file), sha256: archive.sha256 };
});
const exec = promisify(execFile), quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sshArgs = ['-o', 'BatchMode=yes', ...(remoteEndpoint.port ? ['-p', String(remoteEndpoint.port)] : []),
    ...(remoteEndpoint.identityFile ? ['-i', remoteEndpoint.identityFile] : [])];
assert(remoteEndpoint.port === undefined || Number.isInteger(remoteEndpoint.port) && remoteEndpoint.port > 0 && remoteEndpoint.port < 65536);
assert(remoteEndpoint.identityFile === undefined || absolute(remoteEndpoint.identityFile));
const ssh = async (args) => (await exec('ssh', [...sshArgs, sshTarget, args.map(quote).join(' ')], { maxBuffer: 20 * 1024 * 1024 })).stdout;
const remoteCheck = `const f=require('node:fs'),c=require('node:crypto'),p=require('node:path');const v=JSON.parse(process.argv[1]);const marker=JSON.parse(f.readFileSync(p.join(v.root,'.agentmux-cross-host-test-root.json'),'utf8'));const digest=file=>c.createHash('sha256').update(f.readFileSync(file)).digest('hex');console.log(JSON.stringify({marker,node:process.version,platform:process.platform,arch:process.arch,consumers:Object.fromEntries(v.files.map(file=>[file,digest(p.join(v.packageRoot,file))])),archives:Object.fromEntries(v.archives.map(file=>[file,digest(p.join(v.root,'archives',file))]))}));`;
const installedObservation = JSON.parse(await ssh([remoteNodePath, '-e', remoteCheck, JSON.stringify({ root: remoteRoot, packageRoot: remotePackageRoot, files: Object.keys(consumerHashes), archives: archives.map(value => value.file) })]));
assert.deepEqual(installedObservation.marker, { schema: 'agentmux.cross-host-test-installation.v1', scopeId: candidate.scopeId, sourceCommit: candidateCommit, hostId: authorization.remote.hostId, profileRoot:candidate.remote.profileRoot, nodePath:candidate.remote.nodePath }, 'Private installation marker does not match the authorized candidate');
assert.equal(installedObservation.platform, authorization.remote.platform);
assert.equal(installedObservation.arch, authorization.remote.architecture === 'x86_64' ? 'x64' : authorization.remote.architecture);
assert.equal(installedObservation.node, authorization.remote.verifiedNodeVersion);
assert.deepEqual(installedObservation.consumers, consumerHashes, 'Remote installed consumers differ from the requested candidate');
for (const archive of archives)
    assert.equal(installedObservation.archives[archive.file], archive.sha256, 'Remote published archive changed');
const input = { packageRoot, remoteRoot, remotePackageRoot, remoteNodePath, sshTarget, candidateCommit,
    localCodexDirectory: candidate.local.codexDirectory, remoteCodexDirectory: candidate.remote.codexDirectory,
    remoteProfileRoot: candidate.remote.profileRoot, remoteEndpoint, mode, directions: direction === 'both' ? ['remote-agent', 'local-agent'] : [direction] };
const { connectAgentMuxRpc } = await import(pathToFileURL(join(packageRoot, 'dist/public-rpc-client.js')));
const { connectHostedAgentMux } = await import(pathToFileURL(join(packageRoot, 'dist/hosted-client.js')));
const resolveCandidate = createRequire(join(packageRoot, 'package.json'));
const xterm = (await import(pathToFileURL(resolveCandidate.resolve('@xterm/headless')))).default;
const ownerFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/cross-host-execution-owner.mjs');
const root = await fs.realpath(await fs.mkdtemp('/tmp/amx-gap-'));
const deadline = (promise, label, ms = 60000) => { let timer; return Promise.race([promise, new Promise((_, rej) => timer = setTimeout(() => rej(Error(label + ' timeout')), ms))]).finally(() => clearTimeout(timer)); };
const until = async (fn, label) => { const end = Date.now() + 60000; while (Date.now() < end) {
    if (await fn())
        return;
    await new Promise(r => setTimeout(r, 100));
} throw Error(label + ' timeout'); };
const owners = [], requests = [], cliReceipts = [], results = [], errors = [], connections = new Set();
let active, terminal, release, summary;
const localBase = join(root, 'local'), remoteBase = join(remoteRoot, 'run-' + randomUUID().slice(0, 8));
const save = async (name, value) => fs.writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
await save('input.json', { ...input, root, localBase, remoteBase, authorization: { receiptPath, sha256: sha256(authorizationBytes), source: authorization.source }, installedObservation, consumerHashes, archives, startedAt: new Date().toISOString(), harnessHashes: { verifier: sha256(await fs.readFile(fileURLToPath(import.meta.url))), owner: sha256(await fs.readFile(ownerFixture)) } });
const model = createServer(async (req, res) => {
    try {
        if (req.method === 'GET') {
            res.end('{"data":[]}');
            return;
        }
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        const value = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(value);
        await save('model-requests.json', requests);
        const text = JSON.stringify(value.input), tools = (value.tools ?? []).flatMap(t => t.type === 'namespace' ? t.tools.map(child => ({ ...child, namespace: t.name })) : [t]);
        let item;
        const call = (name, args, id) => { const tool = tools.find(t => t.name === name); assert(tool, 'Declared ' + name); return { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), ...(tool.namespace ? { namespace: tool.namespace } : {}) }; };
        if (!tools.length)
            item = { type: 'message', id: 'title-' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Two-host execution', annotations: [] }] };
        else {
            assert(active && text.includes(active.marker), 'Native request must retain original prompt');
            const phase = text.includes('CUT_' + active.marker) ? 'cut' : text.includes('RESUME_' + active.marker) ? 'resume' : 'initial';
            const effect = 'call_' + phase + '_effect_' + active.name, modify = 'call_' + phase + '_modify_' + active.name;
            if (phase !== 'initial')
                assert(text.includes('COMPLETE_INITIAL_' + active.marker), 'Resumed model request must contain original completion');
            if (phase === 'cut')
                assert(text.includes('COMPLETE_RESUME_' + active.marker), 'Third turn must retain resumed completion');
            if (!text.includes(effect)) {
                const code = phase === 'initial' ? "const f=require('node:fs');f.appendFileSync('effects.txt','once\\n');f.writeFileSync('note.txt','initial\\n');console.log(JSON.stringify({platform:process.platform,cwd:process.cwd(),marker:f.readFileSync('resource-marker.txt','utf8')}))" : phase === 'resume' ? "const f=require('node:fs');f.appendFileSync('resume-effects.txt','once\\n');console.log(f.readFileSync('note.txt','utf8')+f.readFileSync('effects.txt','utf8'))" : "const f=require('node:fs');f.appendFileSync('long-effects.txt','once\\n');f.writeFileSync('long-started.txt','started');const timer=setInterval(()=>{if(f.existsSync('release-long.txt')){clearInterval(timer);f.writeFileSync('long-done.txt','done');console.log('ORIGINAL_LONG_RESULT_'+f.readFileSync('resource-marker.txt','utf8'))}},100)";
                item = call('exec_command', { cmd: quote(active.nodePath) + ' -e ' + quote(code), workdir: active.workspace, yield_time_ms: phase === 'cut' ? 30000 : 1000, max_output_tokens: 1000 }, effect);
            }
            else if (!text.includes(modify)) {
                const before = phase === 'initial' ? 'initial' : phase === 'resume' ? 'modified' : 'resumed', after = phase === 'initial' ? 'modified' : phase === 'resume' ? 'resumed' : 'after-cut';
                const patch = '*** Begin Patch\n*** Update File: ' + join(active.workspace, 'note.txt') + '\n@@\n-' + before + '\n+' + after + '\n*** End Patch';
                const t = tools.find(t => t.name === 'apply_patch');
                item = t ? { type: 'custom_tool_call', call_id: modify, name: 'apply_patch', input: patch, ...(t.namespace ? { namespace: t.namespace } : {}) } : call('exec_command', { cmd: "apply_patch <<'PATCH'\n" + patch + "\nPATCH", workdir: active.workspace, yield_time_ms: 1000, max_output_tokens: 1000 }, modify);
            }
            else
                item = { type: 'message', id: 'answer-' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'COMPLETE_' + phase.toUpperCase() + '_' + active.marker, annotations: [] }] };
        }
        const id = 'response-' + requests.length;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = v => res.write('data: ' + JSON.stringify(v) + '\n\n');
        event({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
        if (item.type === 'message') {
            event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
            event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
            event({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: item.content[0].text });
        }
        event({ type: 'response.output_item.done', output_index: 0, item });
        event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
        res.end();
    }
    catch (e) {
        errors.push(String(e));
        res.writeHead(500);
        res.end('Fixture rejected request');
    }
});
model.on('connection', s => { connections.add(s); s.once('close', () => connections.delete(s)); });
await new Promise(r => model.listen(0, '127.0.0.1', r));
const port = model.address().port;
async function startOwner(name, cfg) {
    const file = join(root, name + '-owner.json');
    await fs.writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
    let proc;
    if (name === 'remote') {
        // One new scope, never an old service directory or a replayed creation.
        await ssh([remoteNodePath, '-e', 'require("node:fs").mkdirSync(process.argv[1],{mode:0o700})', remoteBase]);
        const scpArgs = [...(remoteEndpoint.port ? ['-P', String(remoteEndpoint.port)] : []), ...(remoteEndpoint.identityFile ? ['-i', remoteEndpoint.identityFile] : [])];
        await exec('scp', [...scpArgs, file, ownerFixture, sshTarget + ':' + remoteBase + '/']);
        proc = spawn('ssh', ['-T', ...sshArgs, '-o', 'ExitOnForwardFailure=yes', '-R', cfg.modelPort + ':127.0.0.1:' + port, sshTarget, [remoteNodePath, join(remoteBase, 'cross-host-execution-owner.mjs'), join(remoteBase, name + '-owner.json')].map(quote).join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    else
        proc = spawn(process.execPath, [ownerFixture, file], { stdio: ['pipe', 'pipe', 'pipe'] });
    const owner = { name, proc, cfg, stderr: '', cleanup: null };
    owners.push(owner);
    proc.stderr.on('data', b => owner.stderr += b);
    const lines = createInterface({ input: proc.stdout });
    owner.lines = lines;
    const [line] = await deadline(Promise.race([once(lines, 'line'), once(proc, 'exit').then(() => { throw Error(name + ' owner exited: ' + owner.stderr); })]), name + ' owner ready');
    Object.assign(owner, JSON.parse(line));
    await save(name + '-owner-ready.json', ownerResult(owner));
    return owner;
}
const ownerResult = o => ({ name: o.name, base: o.base, socketPath: o.socketPath, owner: o.owner, node:o.node, nativeVersion:o.nativeVersion, candidateCommit:o.candidateCommit, corePid: o.corePid, nativePid: o.nativePid, platform: o.platform, arch: o.arch });
async function connect(owner, endpoint) { owner.endpoint = endpoint; owner.rpc = await connectAgentMuxRpc({ endpoint }); owner.client = await connectHostedAgentMux({ rpc: owner.rpc }); await owner.client.connectRuntime(); owner.releaseDiagnostics = owner.client.onEvent(event => { if (event.type === 'agent-error') {
    void fs.appendFile(join(root, owner.name + '-agent-errors.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
} }, { observeMessages: false }); }
async function read(owner, path) { return owner.name === 'local' ? await fs.readFile(path, 'utf8') : await ssh([remoteNodePath, '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', path]); }
async function exists(owner, path) { return owner.name === 'local' ? await fs.stat(path).then(() => true, () => false) : (await ssh([remoteNodePath, '-e', 'console.log(require("node:fs").existsSync(process.argv[1]))', path])).trim() === 'true'; }
function pair(local, bindingId) { const db = new DatabaseSync(join(local.base, 'state/execution-bindings/bindings.sqlite'), { readOnly: true }); try {
    const row = db.prepare('SELECT binding_intents.input,bindings.record FROM bindings JOIN binding_intents USING(id) WHERE id=?').get(bindingId);
    assert(row);
    return { input: JSON.parse(row.input), ...JSON.parse(row.record) };
}
finally {
    db.close();
} }
async function frames(owner, runId) { const replay = await owner.client.readRunReplay({ runId }, 0, 'raw'); assert.equal(replay.gap, null); const bytes = Buffer.concat(replay.replay.map(c => Buffer.from(c.dataBytes))); const text = bytes.toString(); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(x => JSON.parse(x)); }
async function rangedFrames(owner, runId) { const r = await owner.client.readRunReplay({ runId }, 0, 'raw'); assert.equal(r.gap, null); assert.equal(r.replay[0].startByte, 0); const b = Buffer.concat(r.replay.map(c => Buffer.from(c.dataBytes))); let from = 0; const frames = []; for (;;) {
    const end = b.indexOf(10, from);
    if (end < 0)
        break;
    frames.push({ startByte: from, endByte: end + 1, frame: JSON.parse(b.subarray(from, end).toString()) });
    from = end + 1;
} return frames; }
async function cli(local, args) { const started = performance.now(); const p = spawn(process.execPath, [join(packageRoot, 'bin/amux'), '--endpoint', 'unix:' + local.socketPath, ...args], { env: { PATH: process.env.PATH, HOME: join(local.base, 'home'), LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b); const [code] = await deadline(once(p, 'close'), 'CLI response'); const packet = stdout.trim() ? JSON.parse(stdout) : stderr.split('\n').flatMap(l => { try {
    const x = JSON.parse(l);
    return x.ok === false ? [x] : [];
}
catch {
    return [];
} })[0]; const receipt = { args, code, packet, stderr, elapsedMs: performance.now() - started }; cliReceipts.push(receipt); await save('cli-receipts.json', cliReceipts); return receipt; }
async function control(owner, action) { const id = randomUUID(); const reply = deadline(new Promise((resolve, reject) => { const onLine = line => { const value = JSON.parse(line); if (value.error) {
    owner.lines.off('line', onLine);
    reject(Error(value.error));
}
else if (value.id === id) {
    owner.lines.off('line', onLine);
    resolve(value.result);
} }; owner.lines.on('line', onLine); }), 'owner ' + action); owner.proc.stdin.write(JSON.stringify({ id, action }) + '\n'); return await reply; }
async function restart(owner) { owner.releaseDiagnostics?.(); await owner.client.dispose(); await owner.rpc.dispose(); const before = ownerResult(owner), result = await control(owner, 'restart-core'); Object.assign(owner, result.receipt); await connect(owner, owner.endpoint); assert.notEqual(result.oldPid, owner.corePid); assert.equal(before.nativePid, owner.nativePid); assert.equal(before.owner.runtimeId, owner.owner.runtimeId); assert.notEqual(before.owner.ownerInstanceId, owner.owner.ownerInstanceId); return { before, result, after: ownerResult(owner) }; }
async function useTerminal(agent, session) { release?.(); terminal?.dispose(); terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true }); terminal.onData(data => { void agent.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data, source: 'terminal-protocol' }).catch(e => errors.push(String(e))); }); release = agent.client.onEvent(event => { if (event.type === 'terminal-output' && event.run.runId === session.run.runId)
    terminal.write(event.dataBytes); }, { observeMessages: false }); const attached = await agent.client.reattachAgent(session.agentSessionId, 0, 'raw'); for (const chunk of attached.attachment.replay)
    terminal.write(chunk.dataBytes); }
async function exitCli(agent, session) { await agent.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: '\x04', source: 'user' }); await until(async () => (await agent.client.statusAgent(session.agentSessionId)).run.state === 'exited', 'Original native CLI natural exit'); release?.(); release = undefined; terminal?.dispose(); terminal = undefined; }
async function helperFacts(agent, resource, originalPair) { const result = {}; for (const [side, host] of [['frontend', agent], ['executor', resource]]) {
    const observed = await host.client.readRunReplay({ runId: originalPair[side].runId }, 0, 'raw');
    result[side] = { run: observed.run, ctxmux: host.client.runtimeIdentity(), core: host.client.runtimeOwnerIdentity() };
} return result; }
function sameHelpers(before, after) { for (const side of ['frontend', 'executor']) {
    assert.equal(after[side].run.runId, before[side].run.runId);
    assert.equal(after[side].run.pid, before[side].run.pid);
    assert.equal(after[side].run.state, 'running');
    assert.equal(after[side].ctxmux.instanceId, before[side].ctxmux.instanceId);
    assert.equal(after[side].core.runtimeId, before[side].core.runtimeId);
} }
async function writeResource(owner, path, text) { if (owner.name === 'local')
    await fs.writeFile(path, text);
else
    await ssh([remoteNodePath, '-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', path, text]); }
try {
    const remotePort = Number((await ssh([remoteNodePath, '-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"])).trim());
    const remote = await startOwner('remote', { base: remoteBase, profileBase: join(input.remoteProfileRoot, remoteBase.split('/').at(-1)), expectedSourceCommit: candidateCommit, packageRoot: remotePackageRoot, nodePath: remoteNodePath, codexPath: input.remoteCodexDirectory, modelPort: remotePort });
    const endpoint = { ...remoteEndpoint, socketPath: remote.socketPath, command: candidate.remote.command };
    await connect(remote, endpoint);
    const local = await startOwner('local', { base: localBase, expectedSourceCommit: candidateCommit, packageRoot, nodePath: process.execPath, codexPath: input.localCodexDirectory, modelPort: port, remote: endpoint });
    await connect(local, { transport: 'unix', path: local.socketPath });
    assert.notEqual(local.client.runtimeOwnerIdentity().runtimeId, remote.client.runtimeOwnerIdentity().runtimeId);
    for (const owner of [local, remote]) {
        owner.configured = await owner.client.configureHostExecutor({ executorId: 'native-dual-proof', config: { label: 'Native dual host proof', providerId: 'codex', command: 'codex', args: ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'], env: {}, injectAgentMuxGuide: false } });
        if (owner.name === 'local')
            await fs.writeFile(join(owner.base, 'workspace/resource-marker.txt'), randomUUID());
        else
            await ssh([remoteNodePath, '-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', join(owner.base, 'workspace/resource-marker.txt'), randomUUID()]);
    }
    for (const direction of [{ name: 'remote-agent', agent: remote, resource: local }, { name: 'local-agent', agent: local, resource: remote }].filter(d => !input.directions || input.directions.includes(d.name))) {
        const directionStarted = performance.now();
        const { agent, resource, name } = direction, bindingId = randomUUID(), agentSessionId = randomUUID(), workspace = join(resource.base, 'workspace');
        active = { name, marker: 'FLOW_' + randomUUID(), workspace, nodePath: resource.name === 'local' ? process.execPath : remoteNodePath };
        assert.equal(await exists(agent, workspace), false, 'Resource absolute path must not exist on Agent machine');
        const create = { bindingId, agentHostId: agent.name, agentRuntimeId: agent.client.runtimeOwnerIdentity().runtimeId, resourceHostId: resource.name, resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, resourceWorkspacePath: workspace, resourceGrant: { scope: 'host-user', bindingId }, agent: { agentSessionId, createOperationId: randomUUID(), executorId: agent.configured.executor.executorId, executorRevision: agent.configured.executor.configRevision, workspacePath: join(agent.base, 'workspace'), prompt: active.marker + ': execute the controlled native tools.' } };
        const file = join(root, name + '-create.json');
        await fs.writeFile(file, JSON.stringify(create), { mode: 0o600 });
        const result = await cli(local, ['agent', 'execution', 'create', '--input', file]);
        assert.equal(result.code, 0, JSON.stringify(result.packet));
        const session = result.packet.result.session;
        assert.equal(session.agentSessionId, agentSessionId);
        assert.deepEqual(session.toolExecution, { bindingId, resourceHostId: resource.name, resourceRuntimeId: create.resourceRuntimeId, workspacePath: workspace });
        const originalPair = pair(local, bindingId);
        await save(name + '-pair.json', originalPair);
        assert.deepEqual(originalPair.input, create);
        terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
        terminal.onData(data => { void agent.client.writeAgent({ agentSessionId, expectedRun: session.run, data, source: 'terminal-protocol' }).catch(e => errors.push(String(e))); });
        release = agent.client.onEvent(event => { if (event.type === 'terminal-output' && event.run.runId === session.run.runId)
            terminal.write(event.dataBytes); }, { observeMessages: false });
        const attached = await agent.client.reattachAgent(agentSessionId, 0, 'raw');
        for (const chunk of attached.attachment.replay)
            terminal.write(chunk.dataBytes);
        await until(async () => await read(resource, join(workspace, 'note.txt')).catch(() => null) === 'modified\n', name + ' file effect');
        await until(() => requests.some(r => JSON.stringify(r.input).includes('call_initial_modify_' + name)), name + ' tool result');
        assert.equal(await read(resource, join(workspace, 'effects.txt')), 'once\n');
        assert.equal(await exists(agent, workspace), false);
        const originalFrames = await frames(agent, originalPair.frontend.runId);
        await save(name + '-frames.json', originalFrames);
        const op = originalFrames.find(f => f.payload?.method === 'process/start' && f.payload.params.metadata?.toolCallId === 'call_initial_effect_' + name);
        assert(op);
        assert.equal(originalFrames.filter(f => f.payload?.method === 'process/start' && f.payload.params.metadata?.toolCallId === 'call_initial_effect_' + name).length, 1);
        assert(originalFrames.some(f => f.payload?.method === 'fs/writeFile' && f.payload.params.path === pathToFileURL(join(workspace, 'note.txt')).href));
        const inspection = await cli(local, ['agent', 'execution', 'inspect', '--host', resource.name, '--binding', bindingId, '--generation', op.generation, '--request-json', JSON.stringify(op.payload.id)]);
        assert.equal(inspection.code, 0, JSON.stringify(inspection.packet));
        assert.equal(inspection.packet.result.phase, 'completed');
        const bindingFile = join(root, name + '-binding.json');
        await fs.writeFile(bindingFile, JSON.stringify({ bindingId }));
        const binding = await cli(local, ['agent', 'execution', 'binding', '--input', bindingFile]);
        assert.equal(binding.code, 0);
        assert.equal(binding.packet.result.state, 'connected');
        const stages = { initialMs: performance.now() - directionStarted };
        const nativeResult = { name, bindingId, agentSessionId, originalRun: session.run, toolExecution: session.toolExecution, agentPlatform: agent.platform, resourcePlatform: resource.platform, originalHelperRuns: [originalPair.frontend.runId, originalPair.executor.runId], resourcePathAbsentOnAgent: true, originalEffectCount: 1, operation: inspection.packet.result, stages };
        if (mode === 'native') {
            results.push(nativeResult);
            await save('results.json', results);
            await agent.client.stopAgent(agentSessionId, session.run);
            release();
            release = undefined;
            terminal.dispose();
            terminal = undefined;
            continue;
        }
        let retained;
        const nativeId = op.payload.params.metadata.threadId;
        await until(async () => { retained = await agent.client.refreshAgentSession(agentSessionId, session.run); return retained.nativeHandle?.sessionId === nativeId && typeof retained.nativeHandle?.transcriptPath === 'string'; }, 'Original Core native handle capture');
        const transcriptPath = retained.nativeHandle.transcriptPath;
        await until(async () => (await read(agent, transcriptPath)).includes('COMPLETE_INITIAL_' + active.marker), 'Original native final transcript');
        await exitCli(agent, session);
        const beforeRestart = await helperFacts(agent, resource, originalPair), restartStarted = performance.now(), restarts = [];
        // Both physical semantic owners restart; original ctxmux and helper Runs remain.
        restarts.push(await restart(remote));
        restarts.push(await restart(local));
        const afterRestart = await helperFacts(agent, resource, originalPair);
        sameHelpers(beforeRestart, afterRestart);
        let restoredBinding;
        await until(async () => { restoredBinding = await local.rpc.call('agent.execution.binding', { bindingId }); return restoredBinding?.state === 'connected'; }, 'Automatic original binding readers after Core restart');
        const retainedAfterRestart = await agent.client.readAgentSession(agentSessionId);
        assert.equal(retainedAfterRestart.nativeHandle?.sessionId, nativeId);
        assert.deepEqual(retainedAfterRestart.toolExecution, session.toolExecution);
        const resumed = await agent.client.resumeAgent({ agentSessionId, operationId: randomUUID(), prompt: 'RESUME_' + active.marker + ': retain original context and check resource state.' });
        assert.equal(resumed.agentSessionId, agentSessionId);
        assert.equal(resumed.nativeHandle?.sessionId, nativeId);
        assert.deepEqual(resumed.toolExecution, session.toolExecution);
        await useTerminal(agent, resumed);
        await until(async () => (await read(resource, join(workspace, 'note.txt')).catch(() => null)) === 'resumed\n', 'Original native resume file operation');
        await until(async () => (await read(agent, transcriptPath)).includes('COMPLETE_RESUME_' + active.marker), 'Original native resume final transcript');
        assert.equal(await read(resource, join(workspace, 'effects.txt')), 'once\n');
        assert.equal(await read(resource, join(workspace, 'resume-effects.txt')), 'once\n');
        stages.restartAndResumeMs = performance.now() - restartStarted;
        const resumedFrames = await frames(agent, originalPair.frontend.runId), resumeOp = resumedFrames.find(f => f.payload?.method === 'process/start' && f.payload.params.metadata?.toolCallId === 'call_resume_effect_' + name);
        assert(resumeOp);
        assert.equal(resumeOp.payload.params.metadata.threadId, nativeId);
        assert.notEqual(resumeOp.generation, op.generation);
        await save(name + '-resume.json', { bindingId, agentSessionId, nativeId, transcriptPath, original: session, resumed, beforeRestart, afterRestart, restarts, restoredBinding, resumeOp, stages });
        await exitCli(agent, resumed);
        if (mode === 'recovery') {
            results.push({ ...nativeResult, nativeId, resumedRun: resumed.run, beforeRestart, afterRestart, coreRestarts: restarts, contextRetained: true, resumeEffectCount: 1 });
            await save('results.json', results);
            continue;
        }
        const cutStarted = performance.now();
        const inFlight = await agent.client.resumeAgent({ agentSessionId, operationId: randomUUID(), prompt: 'CUT_' + active.marker + ': run the original long native command and retain all prior context.' });
        assert.equal(inFlight.nativeHandle?.sessionId, nativeId);
        await useTerminal(agent, inFlight);
        await until(() => exists(resource, join(workspace, 'long-started.txt')), 'Original long command effect');
        assert.equal(await read(resource, join(workspace, 'long-effects.txt')), 'once\n');
        const inFlightFrames = await frames(agent, originalPair.frontend.runId), longOp = inFlightFrames.find(f => f.payload?.method === 'process/start' && f.payload.params.metadata?.toolCallId === 'call_cut_effect_' + name);
        assert(longOp);
        assert.equal(longOp.payload.params.metadata.threadId, nativeId);
        const key = { bindingId, streamGeneration: longOp.generation, nativeRequestId: longOp.payload.id };
        const beforeCutOperation = await resource.client.inspectAgentExecutionOperation(key);
        assert(beforeCutOperation);
        assert(['dispatched', 'completed'].includes(beforeCutOperation.phase));
        const beforeCut = await helperFacts(agent, resource, originalPair), pause = await control(local, 'pause-transport');
        const stoppedState = (await exec('ps', ['-p', String(pause.cut.pid), '-o', 'stat='])).stdout.trim();
        assert(stoppedState.includes('T'), 'Exact SSH must be stopped by the kernel');
        const pausedPair = pair(local, bindingId);
        await writeResource(resource, join(workspace, 'release-long.txt'), 'release original process');
        await until(() => exists(resource, join(workspace, 'long-done.txt')), 'Original native command completes during reader gap');
        let nativeExit;
        await until(async () => { nativeExit = (await rangedFrames(resource, originalPair.executor.runId)).find(f => f.frame.payload?.method === 'process/exited' && f.frame.payload.params.processId === longOp.payload.params.processId); return !!nativeExit; }, 'Original exit notification retained while SSH is stopped');
        const gapPair = pair(local, bindingId);
        assert(gapPair.bridge.executor.outputByte < nativeExit.endByte, 'Original exit bytes must remain beyond the coordinator acknowledged cursor');
        const cutBinding = await local.rpc.call('agent.execution.binding', { bindingId });
        const cut = await control(local, 'drop-transport');
        assert.equal(cut.cut.pid, pause.cut.pid);
        assert.equal(cut.signal, 'SIGKILL');
        await until(() => { try {
            process.kill(cut.cut.pid, 0);
            return false;
        }
        catch (e) {
            if (e.code === 'ESRCH')
                return true;
            throw e;
        } }, 'Exact stopped test SSH process exit');
        await save(name + '-reader-gap.json', { pause, stoppedState, pausedPair, gapPair, nativeExit, cut });
        const duringCutOperation = await resource.client.inspectAgentExecutionOperation(key);
        assert.equal(duringCutOperation.payloadDigest, beforeCutOperation.payloadDigest);
        const rejoined = await cli(local, ['agent', 'execution', 'rejoin', '--input', bindingFile]);
        assert.equal(rejoined.code, 0, JSON.stringify(rejoined.packet));
        assert.equal(rejoined.packet.result.state, 'connected', JSON.stringify(rejoined.packet.result));
        await until(async () => (await read(resource, join(workspace, 'note.txt')).catch(() => null)) === 'after-cut\n', 'Original late result and native file operation after rejoin');
        await until(async () => (await read(agent, transcriptPath)).includes('COMPLETE_CUT_' + active.marker), 'Original native conversation completes after transport cut');
        const afterCut = await helperFacts(agent, resource, originalPair);
        sameHelpers(beforeCut, afterCut);
        const finalFrames = await frames(agent, originalPair.frontend.runId);
        await save(name + '-final-frames.json', finalFrames);
        assert.equal(finalFrames.filter(f => f.payload?.method === 'process/start' && f.payload.params.metadata?.toolCallId === 'call_cut_effect_' + name).length, 1);
        assert.equal(await read(resource, join(workspace, 'long-effects.txt')), 'once\n');
        assert.equal(await read(resource, join(workspace, 'effects.txt')), 'once\n');
        const finalOperation = await resource.client.inspectAgentExecutionOperation(key);
        assert.equal(finalOperation.phase, 'completed');
        assert.equal(finalOperation.payloadDigest, beforeCutOperation.payloadDigest);
        if (duringCutOperation.resultDigest !== null)
            assert.equal(finalOperation.resultDigest, duringCutOperation.resultDigest);
        const finalPair = pair(local, bindingId);
        assert.deepEqual(finalPair.input, create);
        for (const side of ['frontend', 'executor']) {
            assert.equal(finalPair[side].runId, originalPair[side].runId);
            assert.equal(finalPair.bridge[side].ownerInstanceId, originalPair.bridge[side].ownerInstanceId);
        }
        stages.inFlightCutAndRejoinMs = performance.now() - cutStarted;
        const resultRecord = { name, bindingId, agentSessionId, nativeId, originalRun: session.run, resumedRun: resumed.run, longRun: inFlight.run, toolExecution: session.toolExecution, agentPlatform: agent.platform, resourcePlatform: resource.platform, nativeCodexVersion: '0.165.0', originalHelperRuns: [originalPair.frontend.runId, originalPair.executor.runId], resourcePathAbsentOnAgent: !(await exists(agent, workspace)), originalEffectCount: 1, resumeEffectCount: 1, longEffectCount: 1, coreRestarts: restarts, contextRetained: true, beforeCutOperation, duringCutOperation, finalOperation, longOp, pause, nativeExit, pausedOutputByte: pausedPair.bridge.executor.outputByte, gapOutputByte: gapPair.bridge.executor.outputByte, cut, cutBinding, rejoined: rejoined.packet.result, beforeCut, afterCut, stages, protocolFrames: finalFrames.length, protocolJsonBytes: Buffer.byteLength(JSON.stringify(finalFrames)) };
        results.push(resultRecord);
        await save('results.json', results);
        await save(name + '-cut.json', resultRecord);
        await exitCli(agent, inFlight);
    }
    assert.equal(results.length, input.directions.length);
    assert(results.length > 0);
    assert.deepEqual(errors, []);
    summary = { passed: true, mode, candidateCommit, actualMachines: 2, controlledModel: true, bothDirectionsPassed: results.length === 2, fullRemoteGatePassed: false, scope: mode === 'native' ? 'Native file and process operations only' : mode === 'recovery' ? 'Native file/process operations and original SID/native conversation after exact test Core restarts' : 'Native work, original SID/native conversation recovery and original exit notifications across an exact SSH reader byte gap; excludes strictly-dispatched unknown effects, amux relay, hooks/MCP/skills, performance and UI', results };
}
catch (error) {
    await save('failure.json', { error: String(error), stack: error.stack, errors, owners: owners.map(ownerResult) });
    console.error(JSON.stringify({ passed: false, evidence: root, error: String(error) }));
    process.exitCode = 1;
}
finally {
    release?.();
    terminal?.dispose();
    for (const owner of [...owners].reverse()) {
        await owner.client?.dispose().catch(() => { });
        await owner.rpc?.dispose().catch(() => { });
        if (owner.proc.exitCode === null) {
            const ended = once(owner.proc, 'exit');
            owner.proc.stdin.write('stop\n');
            await deadline(ended, owner.name + ' cleanup').catch(e => errors.push(String(e)));
        }
        if (owner.proc.exitCode !== 0) errors.push(owner.name + ' supervisor cleanup exit unconfirmed: ' + owner.proc.exitCode);
        await save(owner.name + '-supervisor.json', { ...ownerResult(owner), exitCode: owner.proc.exitCode, stderr: owner.stderr });
    }
    for (const s of connections)
        s.destroy();
    await new Promise(r => model.close(r));
    await save('final-errors.json', errors);
}

if (summary) {
  summary.passed = errors.length === 0; summary.cleanupErrors = errors;
  if (!summary.passed) process.exitCode = 1;
  await save('summary.json', summary);
  console.log(JSON.stringify({passed:summary.passed, mode, fullRemoteGatePassed:false, evidence:root, results:results.map(value=>({name:value.name,bindingId:value.bindingId}))}));
}
