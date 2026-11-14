import { execFile } from 'node:child_process';
import { afterAll, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ownedBuild = process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT ? undefined : await mkdtemp('/tmp/nnp-build-');
const compiled = process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT ?? (await (await import('./helpers/compile-core-source.mjs')).buildCandidateCore(resolve(import.meta.dirname, '../../..'), ownedBuild!)).core;
afterAll(async () => { if (ownedBuild) await rm(ownedBuild, { recursive: true, force: true }); });
const { NodePublishingOwner } = await import(/* @vite-ignore */ pathToFileURL(join(compiled, 'dist/node-publishing-owner.js')).href) as typeof import('../src/node-publishing-owner.js');
const { parseNodePublishingParams, parseNodePublishingResult } = await import(/* @vite-ignore */ pathToFileURL(join(compiled, 'dist/node-publishing.js')).href) as typeof import('../src/node-publishing.js');
const { durableWriteFile } = await import(/* @vite-ignore */ pathToFileURL(join(compiled, 'dist/durable-write.js')).href) as typeof import('../src/durable-write.js');
const { AgentMuxControlServer } = await import(/* @vite-ignore */ pathToFileURL(join(compiled, 'dist/public-rpc-server.js')).href) as typeof import('../src/public-rpc-server.js');
const { connectAgentMuxRpc } = await import(/* @vite-ignore */ pathToFileURL(join(compiled, 'dist/public-rpc-client.js')).href) as typeof import('../src/public-rpc-client.js');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse())
    await close(); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), 'nnp-')); cleanups.push(() => rm(path, { recursive: true, force: true })); const root = join(path, 'published'), outside = join(path, 'private'); await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'secret'), 'DO NOT PUBLISH'); const owner = new NodePublishingOwner({ stateDirectory: path, runtimeId: 'runtime-original', ownerInstanceId: 'instance-original' }); const initial = await owner.call('settings.node.inspect', {}); const policy = { alias: 'studio-node', shareResources: true, allowedPaths: [root], deniedPaths: [join(root, 'excluded')], defaultPath: root }; const settings = await owner.call('settings.node.configure', { expectedRevision: initial.policyRevision, operationId: 'save-original', policy }); const published = await owner.call('node.inspect', { hostId: 'local' }); return { path, root, outside, owner, initial, policy, settings, published, ref: published.roots[0]!.root }; }
it('separates private owner measurements from withheld public measurements without inventing an alias', async () => { const f = await fixture(); const next = await f.owner.call('settings.node.configure', { expectedRevision: f.settings.policyRevision, operationId: 'withdraw', policy: { ...f.policy, alias: '', shareResources: false } }); expect(next.node.alias).toBe(''); const publicRead = await f.owner.call('node.resources', { hostId: 'local' }); expect(publicRead).toEqual({ node: next.node, policyRevision: next.policyRevision, status: 'withheld' }); const own = await f.owner.call('settings.node.resources', {}); expect(own.status).toBe('available'); if (own.status === 'available') {
    expect(own.sample.processId).toBe(process.pid);
    expect(own.sample.node).toEqual(own.node);
    expect(own.sample.policyRevision).toBe(own.policyRevision);
    expect(own.sample.memory.state).toBe('available');
    expect(own.sample.cpu.state).toBe('available');
} });
it('reads actual bytes and continuing directory pages, hides exclusions and never publishes private absolute paths', async () => { const f = await fixture(); for (const name of ['alpha', 'beta', 'gamma', 'excluded'])
    await writeFile(join(f.root, name), name === 'alpha' ? 'abcdef' : name); await symlink(f.outside, join(f.root, 'escape')); const target = { hostId: 'local', root: f.ref, path: '' }; let offset = 0, revision: string | undefined; const names: string[] = []; do {
    const page = await f.owner.call('node.files.list', { ...target, offset, limit: 1, ...(revision ? { expectedRevision: revision } : {}) });
    names.push(...page.entries.map(e => e.name));
    expect(page.entries).toHaveLength(1);
    revision = page.revision;
    offset = page.nextOffset ?? 0;
    if (page.nextOffset === null)
        break;
} while (true); expect(names.sort()).toEqual(['alpha', 'beta', 'gamma']); expect(JSON.stringify(f.published)).not.toContain(f.root); expect(f.ref.rootId).toMatch(/^[a-f0-9]{64}$/); const first = await f.owner.call('node.files.read', { ...target, path: 'alpha', maxBytes: 2 }); expect(Buffer.from(first.data, 'base64').toString()).toBe('ab'); const second = await f.owner.call('node.files.read', { ...target, path: 'alpha', offset: first.nextOffset!, maxBytes: 4, expectedRevision: first.revision }); expect(Buffer.from(second.data, 'base64').toString()).toBe('cdef'); expect(second.nextOffset).toBeNull(); await expect(f.owner.call('node.files.read', { ...target, path: 'excluded' })).rejects.toMatchObject({ code: 'NODE_PATH_DENIED' }); await expect(f.owner.call('node.files.read', { ...target, path: 'escape/secret' })).rejects.toMatchObject({ code: 'NODE_PATH_DENIED' }); });
it('rejects traversal, another Runtime, replaced root and stale policy without retargeting', async () => { const f = await fixture(); await writeFile(join(f.root, 'file'), 'original'); expect(() => parseNodePublishingParams('node.files.read', { hostId: 'local', root: f.ref, path: '../private/secret' })).toThrow(); await expect(f.owner.call('node.files.read', { hostId: 'local', root: { ...f.ref, runtimeId: 'other' }, path: 'file' })).rejects.toMatchObject({ code: 'NODE_ROOT_MISMATCH' }); await rename(f.root, f.root + '-original'); await mkdir(f.root); await writeFile(join(f.root, 'file'), 'replacement'); await expect(f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'file' })).rejects.toMatchObject({ code: 'NODE_PATH_CHANGED' }); await f.owner.call('settings.node.configure', { expectedRevision: f.settings.policyRevision, operationId: 'new-policy', policy: f.policy }); await expect(f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'file' })).rejects.toMatchObject({ code: 'NODE_POLICY_CHANGED' }); });
it('detects changed files and changed directory continuation without limiting cumulative content', async () => { const f = await fixture(); await writeFile(join(f.root, 'large'), '0123456789'); const p = await f.owner.call('node.files.list', { hostId: 'local', root: f.ref, path: '', limit: 1 }); await writeFile(join(f.root, 'added'), 'a'); await expect(f.owner.call('node.files.list', { hostId: 'local', root: f.ref, path: '', expectedRevision: p.revision, offset: 1 })).rejects.toMatchObject({ code: 'NODE_DIRECTORY_CHANGED' }); const read = await f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'large', maxBytes: 3 }); await writeFile(join(f.root, 'large'), 'changed'); await expect(f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'large', offset: 3, expectedRevision: read.revision })).rejects.toMatchObject({ code: 'NODE_FILE_CHANGED' }); });
it('retains an unknown original save and confirms the same bytes without applying the policy again', async () => { const f = await fixture(); let fail = true, policyWrites = 0; const owner = new NodePublishingOwner({ stateDirectory: f.path, runtimeId: 'runtime-original', ownerInstanceId: 'instance-second', write: async (path, value, options) => { await durableWriteFile(path, value, options); if (path.endsWith('node-publication.json')) {
        policyWrites++;
        if (fail) {
            fail = false;
            throw Error('lost durability acknowledgement');
        }
    } } }); const input = { expectedRevision: f.settings.policyRevision, operationId: 'lost-reply', policy: { ...f.policy, alias: 'renamed-node' } }; const result = await owner.call('settings.node.configure', input); expect(result.operation?.status).toBe('unknown'); expect(result.node.alias).toBe('renamed-node'); const inspected = await owner.call('settings.node.inspect', { operationId: input.operationId }); expect(inspected.operation?.status).toBe('confirmed'); expect(policyWrites).toBe(2); const reopened = new NodePublishingOwner({ stateDirectory: f.path, runtimeId: 'runtime-original', ownerInstanceId: 'instance-reopened' }); const retained = await reopened.call('settings.node.inspect', { operationId: input.operationId }); expect(retained.policy).toEqual(input.policy); expect(retained.operation?.operationId).toBe(input.operationId); expect(retained.node.ownerInstanceId).toBe('instance-reopened'); expect((await reopened.call('node.resolve', { hostId: 'local', alias: 'old-alias', expectedRuntimeId: 'runtime-original' })).node.alias).toBe('renamed-node'); await expect(reopened.call('node.resolve', { hostId: 'local', alias: 'old-alias' })).rejects.toMatchObject({ code: 'NODE_ALIAS_MISMATCH' }); await expect(reopened.call('settings.node.configure', { ...input, policy: f.policy })).rejects.toMatchObject({ code: 'NODE_POLICY_OPERATION_MISMATCH' }); });
it('public server and typed client consume the real persisted owner and reject malformed source results', async () => { const f = await fixture(), server = new AgentMuxControlServer({ socketPath: join(f.path, 'rpc.sock'), coreClients: () => [], nodePublishing: f.owner }); await server.start(); cleanups.push(() => server.stop()); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose()); const value = await rpc.call('node.resources', { hostId: 'local', expectedRuntimeId: 'runtime-original' }); expect(value.status).toBe('available'); if (value.status === 'available') {
    expect(() => parseNodePublishingResult('node.resources', { ...value, sample: { ...value.sample, policyRevision: 'other' } }, { hostId: 'local' })).toThrow();
    expect(() => parseNodePublishingResult('node.resources', { ...value, sample: { ...value.sample, processId: NaN } }, { hostId: 'local' })).toThrow();
} ; expect(() => parseNodePublishingResult('node.resources', { node: f.settings.node, policyRevision: f.settings.policyRevision, status: 'withheld', sample: {} }, { hostId: 'local' })).toThrow(); await expect(rpc.call('node.inspect', { hostId: 'local', expectedRuntimeId: 'other' })).rejects.toMatchObject({ code: 'NODE_RUNTIME_MISMATCH' }); const record = JSON.parse(await readFile(join(f.path, 'node-publication.json'), 'utf8')); expect(record.runtimeId).toBe('runtime-original'); });
it('cancels only this actual directory reader and retains the original policy', async () => { const f = await fixture(); await writeFile(join(f.root, 'file'), 'original'); const control = new AbortController(); const work = f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'file' }, control.signal); setTimeout(() => control.abort(), 0); await expect(work).rejects.toBeDefined(); expect((await f.owner.call('node.inspect', { hostId: 'local' })).policyRevision).toBe(f.settings.policyRevision); const read = await f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'file' }); expect(Buffer.from(read.data, 'base64').toString()).toBe('original'); });
it('keeps missing and denied real IO errors free of private absolute paths', async () => { const f = await fixture(); await writeFile(join(f.root, 'excluded'), 'private'); for (const path of ['missing', 'excluded']) {
    try {
        await f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path });
        throw Error('Expected read to fail');
    }
    catch (error) {
        expect(String(error)).not.toContain(f.path);
        expect((error as {
            code?: string;
        }).code).toMatch(/^NODE_/u);
    }
} });
it('settles an accepted save before inspecting its ID and distinguishes an absent original record', async () => { const f = await fixture(); let release!: () => void; const pause = new Promise<void>(yes => release = yes); let writing!: () => void; const entered = new Promise<void>(yes => writing = yes); const owner = new NodePublishingOwner({ stateDirectory: f.path, runtimeId: 'runtime-original', ownerInstanceId: 'instance-pending', write: async (path, value, opts) => { if (path.endsWith('node-publication.json')) {
        writing();
        await pause;
    } ; await durableWriteFile(path, value, opts); } }); const saving = owner.call('settings.node.configure', { expectedRevision: f.settings.policyRevision, operationId: 'accepted-pending', policy: f.policy }); await entered; let inspected = false; const inspection = owner.call('settings.node.inspect', { operationId: 'accepted-pending' }).then(value => { inspected = true; return value; }); await new Promise(r => setTimeout(r, 10)); expect(inspected).toBe(false); release(); await saving; expect((await inspection).operation?.status).toBe('confirmed'); expect((await owner.call('settings.node.inspect', { operationId: 'not-recorded' })).operation).toBeNull(); await rm(join(f.path, 'node-publication-operations'), { recursive: true }); await expect(owner.call('settings.node.inspect', { operationId: 'accepted-pending' })).rejects.toMatchObject({ code: 'NODE_POLICY_OPERATION_UNAVAILABLE' }); });
it('uses two real isolated Core processes and the actual CLI for remote policy, bytes and same-identity restart', async () => {
    const { nodeRuntimeFixture } = await import('./helpers/node-publishing-runtime.js');
    const b = await nodeRuntimeFixture(undefined, false, compiled);
    cleanups.push(() => b.cleanup());
    const a = await nodeRuntimeFixture(b, false, compiled);
    cleanups.push(() => a.cleanup());
    const root = join(b.root, 'published'), outside = join(b.root, 'not-published');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'alpha'), 'first block');
    await writeFile(join(root, 'beta'), 'next');
    await writeFile(join(root, 'secret'), 'hidden');
    await writeFile(join(outside, 'private'), 'no');
    await symlink(outside, join(root, 'escape'));
    const initial = await b.cli(['settings', 'node', 'inspect']);
    expect(initial.code).toBe(0);
    const policy = { alias: 'real-node-b', shareResources: true, allowedPaths: [root], deniedPaths: [join(root, 'secret')], defaultPath: root };
    const input = { expectedRevision: initial.value.result.policyRevision, operationId: 'private-two-core-save', policy };
    const configured = await b.cli(['settings', 'node', 'configure', '--input', '-'], input);
    expect(configured.code, configured.stdout + configured.stderr).toBe(0);
    expect(configured.value.result.operation.status).toBe('confirmed');
    const metadata = await a.cli(['node', 'inspect', '--host', 'remote-b', '--expected-runtime', b.owner.runtimeId]);
    expect(metadata.code, metadata.stdout + metadata.stderr).toBe(0);
    expect(metadata.value.result.node.runtimeId).toBe(b.owner.runtimeId);
    expect(metadata.stdout).not.toContain(b.root);
    const resources = await a.cli(['node', 'resources', '--host', 'remote-b']);
    expect(resources.code, resources.stdout + resources.stderr).toBe(0);
    expect(resources.value.result.sample.processId).toBe(b.owner.processId);
    expect(resources.value.result.sample.processId).not.toBe(a.owner.processId);
    const ref = metadata.value.result.roots[0].root, target = { hostId: 'remote-b', expectedRuntimeId: b.owner.runtimeId, root: ref, path: '' };
    const first = await a.cli(['node', 'files', 'list', '--input', '-'], { ...target, limit: 1 });
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.value.result.nextOffset).toBe(1);
    const second = await a.cli(['node', 'files', 'list', '--input', '-'], { ...target, offset: 1, limit: 1, expectedRevision: first.value.result.revision });
    expect(second.code).toBe(0);
    expect([...first.value.result.entries, ...second.value.result.entries].map((v: any) => v.name).sort()).toEqual(['alpha', 'beta']);
    expect(second.value.result.nextOffset).toBeNull();
    const bytes = await a.cli(['node', 'files', 'read', '--input', '-'], { ...target, path: 'alpha', maxBytes: 5 });
    expect(bytes.code).toBe(0);
    expect(Buffer.from(bytes.value.result.data, 'base64').toString()).toBe('first');
    for (const path of ['missing', 'secret', 'escape/private']) {
        const failed = await a.cli(['node', 'files', 'read', '--input', '-'], { ...target, path });
        expect(failed.code).not.toBe(0);
        expect(failed.stdout + failed.stderr).not.toContain(b.root);
    }
    const { connectHostedAgentMux } = await import(/* @vite-ignore */ pathToFileURL(join(compiled, 'dist/hosted-client.js')).href) as typeof import('../src/hosted-client.js');
    const sdk = await connectHostedAgentMux({ rpc: b.rpc, expectedRuntimeId: b.owner.runtimeId });
    cleanups.push(() => sdk.dispose());
    await sdk.connect();
    const desktop = await nodeRuntimeFixture(b, true, compiled); cleanups.push(() => desktop.cleanup());
    const sdkA = await connectHostedAgentMux({rpc:desktop.rpc, expectedRuntimeId:desktop.owner.runtimeId}); cleanups.push(() => sdkA.dispose()); await sdkA.connect();
    const credentialFile = join(desktop.root, 'private-managed-credential.json');
    const managed = await sdkA.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: desktop.root,
        createOperationId: 'node-private-managed-agent', injectAgentMuxGuide:false, commandOverride: resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs'),
        env: { AGENTMUX_FAKE_CAPABILITY_RECEIPT: credentialFile } });
    cleanups.push(() => sdkA.stopAgent(managed.agentSessionId,managed.run));
    const credentialDeadline = Date.now() + 20000;
    let credential: { agentSessionId: string; capability: string } | undefined;
    while (!credential) { try { credential = JSON.parse(await readFile(credentialFile, 'utf8')); } catch (error) { if (Date.now() > credentialDeadline) throw error; await new Promise(yes => setTimeout(yes, 20)); } }
    await expect(desktop.rpc.call('node.inspect', { hostId: 'remote-b', expectedRuntimeId:b.owner.runtimeId }, { credentials: credential })).resolves.toMatchObject({node:{runtimeId:b.owner.runtimeId}});
    await expect(desktop.rpc.call('settings.node.configure', { expectedRevision: configured.value.result.policyRevision, operationId: 'another-node-policy-revision', policy }, { credentials: credential })).rejects.toMatchObject({ code: 'NODE_POLICY_CHANGED' });

    const run = await sdk.createTerminal({ createOperationId: 'private-node-policy-healthy-run', workspacePath: b.root, command: process.execPath, args: ['-e', 'process.stdin.on("data",b=>process.stdout.write(b))'] });
    cleanups.push(() => sdk.stopTerminal({ runId: run.runId }));
    const withdrawn = await b.cli(['settings', 'node', 'configure', '--input', '-'], { expectedRevision: configured.value.result.policyRevision, operationId: 'withdraw-public', policy: { ...policy, shareResources: false } });
    expect(withdrawn.code).toBe(0);
    const withheld = await a.cli(['node', 'resources', '--host', 'remote-b']);
    expect(withheld.code).toBe(0);
    expect(withheld.value.result.status).toBe('withheld');
    expect(withheld.value.result).not.toHaveProperty('sample');
    const ownerRead = await b.cli(['settings', 'node', 'resources']);
    expect(ownerRead.value.result.status).toBe('available');
    expect((await desktop.rpc.call('node.resources',{hostId:'remote-b'},{credentials:credential})).status).toBe('withheld');
    const managedCursor=(await sdkA.readRunReplay(managed.run,0,'raw')).run.acceptedInputBytes;expect(typeof managedCursor).toBe('number');
    const managedReceipt = await sdkA.writeTerminal(managed.run,{operationId:'managed-input-after-withdraw',ownerInstanceId:sdkA.runtimeIdentity().instanceId,expectedByte:managedCursor!,data:'still managed\n'});expect(managedReceipt.acceptedThroughByte).toBe(managedCursor!+14);
    const receipt = await sdk.writeTerminal(run, { operationId: 'original-input-after-withdraw', ownerInstanceId: sdk.runtimeIdentity().instanceId, expectedByte: 0, data: 'still healthy\n' });
    expect(receipt).toBeDefined();
    const before = b.owner;
    await b.restart();
    expect(b.owner.runtimeId).toBe(before.runtimeId);
    expect(b.owner.ownerInstanceId).not.toBe(before.ownerInstanceId);
    const persisted = await b.cli(['settings', 'node', 'inspect', '--input', '-'], { operationId: 'withdraw-public' });
    expect(persisted.code, persisted.stdout + persisted.stderr).toBe(0);
    expect(persisted.value.result.policy).toEqual({ ...policy, shareResources: false });
    expect(persisted.value.result.operation.status).toBe('confirmed');
    const after = await a.cli(['node', 'resources', '--host', 'remote-b', '--expected-runtime', before.runtimeId]);
    expect(after.code, after.stdout + after.stderr).toBe(0);
    expect(after.value.result.status).toBe('withheld');
    expect(after.value.result.node.ownerInstanceId).toBe(b.owner.ownerInstanceId);
    if(process.env.AGENTMUX_NODE_TEST_EVIDENCE) await writeFile(join(process.env.AGENTMUX_NODE_TEST_EVIDENCE, 'two-core-receipt.json'), JSON.stringify({ a: a.owner, bBefore: before, bAfter: b.owner, nativePid: b.nativePid,desktopStyleOwner:desktop.owner,managedAgent:{agentSessionId:managed.agentSessionId,run:managed.run,input:managedReceipt}, metadata: metadata.value, resources: resources.value, first: first.value, second: second.value, bytes: bytes.value, withheld: withheld.value, originalRun: { runId: run.runId, pid: run.pid, input: receipt }, persisted: persisted.value, after: after.value, boundary: 'Actual isolated A/B Core processes plus a separate Desktop-style callOriginalCore ingress, official private Native daemons, a controlled Provider CLI process and actual Node CLI. Carriers are private Unix RPC pairs, not physical two-Mac/network tests.' }, null, 2) + '\n');
}, 60000);
it('rechecks configured root aliases and current denied link targets before returning shared bytes', async () => { const f = await fixture(); const first = join(f.root, 'first'), second = join(f.root, 'second'); await mkdir(first); await mkdir(second); await writeFile(join(first, 'file'), 'one'); await writeFile(join(second, 'file'), 'two'); const link = join(f.root, 'excluded-link'); await symlink(first, link); const updated = await f.owner.call('settings.node.configure', { expectedRevision: f.settings.policyRevision, operationId: 'exclude-link', policy: { ...f.policy, deniedPaths: [link] } }); const ref = (await f.owner.call('node.inspect', { hostId: 'local' })).roots[0]!.root; await rm(link); await symlink(second, link); await expect(f.owner.call('node.files.read', { hostId: 'local', root: ref, path: 'second/file' })).rejects.toMatchObject({ code: 'NODE_PATH_DENIED' }); const alias = join(f.path, 'root-alias'); await symlink(first, alias); const aliasSettings = await f.owner.call('settings.node.configure', { expectedRevision: updated.policyRevision, operationId: 'alias-root', policy: { ...f.policy, allowedPaths: [alias], deniedPaths: [], defaultPath: alias } }); const aliasRoot = (await f.owner.call('node.inspect', { hostId: 'local' })).roots[0]!.root; expect(aliasSettings.policyRevision).toBe(aliasRoot.policyRevision); await rm(alias); await symlink(second, alias); await expect(f.owner.call('node.files.read', { hostId: 'local', root: aliasRoot, path: 'file' })).rejects.toMatchObject({ code: 'NODE_PATH_CHANGED' }); });
it('applies the same publication to an authenticated device while keeping owner settings private', async () => { const f = await fixture(); const server = new AgentMuxControlServer({ socketPath: join(f.path, 'device.sock'), nodePublishing: f.owner, coreClients: () => [], http: { host: '127.0.0.1', port: 0, authorize: () => ({ principal: { kind: 'device', id: 'approved-private-device' } }) } }); await server.start(); cleanups.push(() => server.stop()); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-device-fixture' } }); cleanups.push(() => rpc.dispose()); expect((await rpc.call('node.resources', { hostId: 'local' })).status).toBe('available'); await expect(rpc.call('settings.node.resources', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' }); await expect(rpc.call('settings.node.configure', { expectedRevision: f.settings.policyRevision, operationId: 'device-cannot-grant', policy: f.policy })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' }); expect((await f.owner.call('settings.node.inspect', {})).policyRevision).toBe(f.settings.policyRevision); });
it('sanitizes real native permission failures without inventing a zero result', async () => { const f = await fixture(); const file = join(f.root, 'unreadable'); await writeFile(file, 'private'); await chmod(file, 0); try {
    await expect(f.owner.call('node.files.read', { hostId: 'local', root: f.ref, path: 'unreadable' })).rejects.toMatchObject({ code: 'EACCES', message: 'The shared resource is unavailable. Refresh its published root and original path.' });
}
finally {
    await chmod(file, 0o600);
} });

it('the actual CLI marks an unacknowledged original policy save partial and inspect confirms it without replay',async()=>{const f=await fixture();let writes=0;const owner=new NodePublishingOwner({stateDirectory:f.path,runtimeId:'runtime-original',ownerInstanceId:'instance-cli',write:async(path,value,options)=>{await durableWriteFile(path,value,options);if(path.endsWith('node-publication.json')&&++writes===1)throw Error('lost acknowledgement')}});const server=new AgentMuxControlServer({socketPath:join(f.path,'cli.sock'),nodePublishing:owner,coreClients:()=>[]});await server.start();cleanups.push(()=>server.stop());const run=async(args:string[],input:unknown)=>await new Promise<{code:number;value:any}>(yes=>{const child=execFile(process.execPath,[join(compiled,'dist/agentmux.js'),'--endpoint','unix:'+server.path,...args],{env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')))},(error,stdout)=>yes({code:error?typeof error.code==='number'?error.code:1:0,value:JSON.parse(stdout)}));child.stdin!.end(JSON.stringify(input))});const unknown=await run(['settings','node','configure','--input','-'],{expectedRevision:f.settings.policyRevision,operationId:'cli-unknown',policy:f.policy});expect(unknown.code,JSON.stringify(unknown.value)).toBe(1);expect(unknown.value.ok).toBe(true);expect(unknown.value.result.operation).toMatchObject({operationId:'cli-unknown',status:'unknown'});const observed=await run(['settings','node','inspect','--input','-'],{operationId:'cli-unknown'});expect(observed.code).toBe(0);expect(observed.value.result.operation.status).toBe('confirmed');expect(writes).toBe(2)},60000)

it('serializes unknown-save confirmation with a later save so inspection cannot roll the policy back',async()=>{const f=await fixture();let count=0,release!:()=>void,entered!:()=>void,racedWrite!:()=>void;const thirdWrite=new Promise<true>(yes=>racedWrite=()=>yes(true));const pause=new Promise<void>(yes=>release=yes),writing=new Promise<void>(yes=>entered=yes);const owner=new NodePublishingOwner({stateDirectory:f.path,runtimeId:'runtime-original',ownerInstanceId:'instance-serialize',write:async(path,value,options)=>{if(path.endsWith('node-publication.json')){count++;if(count===2){entered();await pause}};await durableWriteFile(path,value,options);if(path.endsWith('node-publication.json')&&count===3)racedWrite();if(path.endsWith('node-publication.json')&&count===1)throw Error('lost acknowledgement')}});const unknown=await owner.call('settings.node.configure',{expectedRevision:f.settings.policyRevision,operationId:'serialize-unknown',policy:f.policy});expect(unknown.operation?.status).toBe('unknown');const inspection=owner.call('settings.node.inspect',{operationId:'serialize-unknown'});await writing;let complete=false;const later=owner.call('settings.node.configure',{expectedRevision:unknown.policyRevision,operationId:'serialize-new-intent',policy:{...f.policy,alias:'latest-policy'}}).then(value=>{complete=true;return value});const raced=await Promise.race([thirdWrite,new Promise<false>(yes=>setTimeout(()=>yes(false),500))]);release();await inspection;const saved=await later;expect(raced).toBe(false);expect(saved.node.alias).toBe('latest-policy');expect((await owner.call('settings.node.inspect',{})).policyRevision).toBe(saved.policyRevision)})

it('filesystem measurements belong to the original published root rather than an escaping default landing',async()=>{const f=await fixture();const link=join(f.root,'default-link');await symlink(f.outside,link);await f.owner.call('settings.node.configure',{expectedRevision:f.settings.policyRevision,operationId:'landing-link',policy:{...f.policy,defaultPath:link}});const root=(await f.owner.call('node.inspect',{hostId:'local'})).roots[0]!.root;await expect(f.owner.call('node.files.list',{hostId:'local',root,path:'default-link'})).rejects.toMatchObject({code:'NODE_PATH_DENIED'});await rename(f.outside,f.outside+'-moved');const sampled=await f.owner.call('node.resources',{hostId:'local'});expect(sampled.status).toBe('available');if(sampled.status==='available'){expect(sampled.sample.filesystem.state).toBe('available');if(sampled.sample.filesystem.state==='available')expect(sampled.sample.filesystem.value.root).toEqual(root)}await rename(f.root,f.root+'-original');await mkdir(f.root);const changed=await f.owner.call('node.resources',{hostId:'local'});expect(changed.status).toBe('available');if(changed.status==='available'){expect(changed.sample.filesystem.state).toBe('unavailable');expect(changed.sample.cpu.state).toBe('available');expect(changed.sample.memory.state).toBe('available')}})
