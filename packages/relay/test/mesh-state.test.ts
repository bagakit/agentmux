import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
const fault = vi.hoisted(() => ({ directory: '', epoch: 0, parent: '', hold: false, calls: 0, holdAt: 1, reached: false, release: undefined as undefined | (() => void) }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (fault.directory && (args[0] === fault.directory || args[0] === fault.parent)) {
        const current = await actual.readFile(join(fault.directory, 'identity.json'), 'utf8').then(JSON.parse, () => null);
        if (current?.epoch === fault.epoch) {
          if (fault.hold) { const sync = file.sync.bind(file); file.sync = async () => { if (++fault.calls === fault.holdAt) { fault.reached = true; await new Promise<void>(resolve => { fault.release = resolve }); } await sync() } }
          else file.sync = async () => { throw Object.assign(Error('Injected lost directory durability acknowledgement'), { code: 'EIO' }); };
        }
      }
      return file;
    } };
});
import { acquireRelayMeshIdentity, inspectRelayMeshState, reconcileRelayMeshState } from '../src/mesh-state.js';
const roots: string[] = [];
const owners: Array<{release(): Promise<void>}> = [];
async function identity(path: string, operationId: string) {
  const owner = await acquireRelayMeshIdentity(path, operationId);
  let released = false;
  const result = {...owner, async release() { if (released) return; released = true; await owner.release(); }};
  owners.push(result); return result;
}
afterEach(async () => {
  fault.release?.(); fault.directory = ''; fault.parent = ''; fault.hold = false; fault.calls = 0; fault.holdAt = 1; fault.reached = false; fault.release = undefined;
  for (const owner of owners.splice(0).reverse()) try { await owner.release() } catch { /* A fault keeps its original durable marker. */ }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() { const root = await mkdtemp(join(tmpdir(), 'mesh-owned-state-')); roots.push(root); return join(root, 'network'); }
async function childState(mode: string, path: string, operationId: string) {
  const result = spawnSync(process.execPath, [resolve('packages/relay/test/fixtures/mesh-state-writer.mjs'), mode, path, operationId], {encoding:'utf8',timeout:5000});
  expect(result.status, result.stderr).toBe(0);
  const actualGuard = await import('../dist/mesh-state-guard.js');
  await vi.waitFor(async () => { const guard = await actualGuard.acquireMeshStateGuard(path, 'observe-child-exit'); await guard.release(); });
  return JSON.parse(result.stdout);
}
it('reserves monotonic epochs with the same private identity and rejects a concurrent owner', async () => {
  const path = await directory(), first = await identity(path, 'first-operation');
  await expect(acquireRelayMeshIdentity(path, 'concurrent-operation')).rejects.toMatchObject({ code: 'MESH_STATE_IN_USE_OR_UNCONFIRMED', operationId: 'concurrent-operation' });
  const recoveryWhileActive = await reconcileRelayMeshState(path, await inspectRelayMeshState(path)).then(() => 'unexpectedly-confirmed', error => error.code);
  expect(recoveryWhileActive).toBe('MESH_STATE_IN_USE_OR_UNCONFIRMED');
  expect((await stat(join(path, 'identity.json'))).mode & 0o077).toBe(0);
  await first.release();
  await expect(reconcileRelayMeshState(path, await inspectRelayMeshState(path))).rejects.toMatchObject({ code: 'MESH_STATE_RECOVERY_CONFLICT' });
  const second = await identity(path, 'next-operation');
  expect(second.identity).toEqual({ ...first.identity, epoch: first.identity.epoch + 1 });
  await second.release();
});
it('preserves the actual committed epoch and original operation after a lost durable-save acknowledgement without guessing lock expiry', async () => {
  const path = await directory(), first = await identity(path, 'first-operation');
  await first.release();
  fault.directory = path;
  fault.epoch = first.identity.epoch + 1;
  await expect(acquireRelayMeshIdentity(path, 'unknown-operation')).rejects.toMatchObject({ code: 'MESH_STATE_DURABILITY_UNKNOWN', operationId: 'unknown-operation' });
  const actual = JSON.parse(await readFile(join(path, 'identity.json'), 'utf8'));
  expect(actual.identity).toEqual({ peerId: first.identity.peerId, publicKey: first.identity.publicKey, secretKey: first.identity.secretKey });
  expect(actual.epoch).toBe(fault.epoch);
  expect(actual.operationId).toBe('unknown-operation');
  const lock = JSON.parse(await readFile(join(path, 'owner.lock', 'owner.json'), 'utf8'));
  expect(lock.operationId).toBe('unknown-operation');
  await expect(acquireRelayMeshIdentity(path, 'never-replay')).rejects.toMatchObject({ code: 'MESH_STATE_IN_USE_OR_UNCONFIRMED' });
  expect(JSON.parse(await readFile(join(path, 'identity.json'), 'utf8'))).toEqual(actual);
});
it('never replaces corrupt or missing original key state with a fresh identity', async () => {
  const path = await directory(), first = await identity(path, 'first-operation');
  await first.release();
  await writeFile(join(path, 'identity.json'), '{corrupt-original');
  await expect(acquireRelayMeshIdentity(path, 'corrupt-read')).rejects.toMatchObject({ code: 'MESH_STATE_UNCONFIRMED' });
  expect(await readFile(join(path, 'identity.json'), 'utf8')).toBe('{corrupt-original');
  await rm(join(path, 'identity.json'));
  await expect(acquireRelayMeshIdentity(path, 'missing-read')).rejects.toMatchObject({ code: 'MESH_STATE_UNCONFIRMED' });
});

it('reconciles only exact original state after durable readback, without replaying an epoch or replacing the guard inode', async () => {
  const path = await directory(), first = await identity(path, 'first-operation'); await first.release();
  const failed = await childState('lost-sync', path, 'unknown-operation');
  expect(failed.error.code).toBe('MESH_STATE_DURABILITY_UNKNOWN');
  const inspection = await inspectRelayMeshState(path), inode = (await stat(join(path, 'owner.guard'))).ino;
  expect(JSON.stringify(inspection)).not.toContain(first.identity.secretKey);
  await expect(reconcileRelayMeshState(path, {...inspection, owner: {...inspection.owner!, ownerId: 'different-owner'}})).rejects.toMatchObject({code: 'MESH_STATE_RECOVERY_CONFLICT'});
  const recovery = await reconcileRelayMeshState(path, inspection);
  expect(recovery).toMatchObject({originalOperationId: 'unknown-operation', originalSaveAcknowledgement: 'not-reconstructed', readbackDurability: 'confirmed', identity: {peerId: first.identity.peerId, epoch: 2}});
  expect((await stat(join(path, 'owner.guard'))).ino).toBe(inode);
  const next = await identity(path, 'explicit-new-operation');
  expect(next.identity).toEqual({...first.identity, epoch: 3}); await next.release();
});
it('includes the entry of a newly created recursive state directory in its durability acknowledgement', async () => {
  const base = await directory(), path = join(base, 'nested', 'state');
  fault.directory = path; fault.parent = dirname(base); fault.epoch = 1;
  await expect(acquireRelayMeshIdentity(path, 'first-parent-unknown')).rejects.toMatchObject({code:'MESH_STATE_DURABILITY_UNKNOWN'});
  const observed = await inspectRelayMeshState(path);
  expect(observed).toMatchObject({state:'observed', identity:{epoch:1}, owner:{operationId:'first-parent-unknown', createdFrom:base}});
  fault.directory = ''; fault.parent = '';
  await expect(reconcileRelayMeshState(path, observed)).rejects.toMatchObject({code:'MESH_STATE_WRITER_ACTIVE_OR_UNCONFIRMED'});
  expect(await inspectRelayMeshState(path)).toEqual(observed);
});
it('a held explicit recovery and a new independent serve use one nonblocking OS guard', async () => {
  const path = await directory(), committed = await childState('commit-exit', path, 'crashed-owner');
  const inspection = committed.inspection, first = inspection.identity;
  fault.directory = path; fault.epoch = 1; fault.hold = true; fault.holdAt = 2;
  const recovering = reconcileRelayMeshState(path, inspection);
  await vi.waitFor(() => expect(fault.reached).toBe(true));
  const config = join(dirname(path), 'competing.json');
  await writeFile(config, JSON.stringify({port:0,publishers:[],meshStateDirectory:path,mesh:{networkId:'guard-race',members:[{peerId:first.peerId,publicKey:first.publicKey}],peers:[]}}));
  const started = Date.now();
  let recovery: Awaited<ReturnType<typeof reconcileRelayMeshState>>;
  try {
    const result = spawnSync(process.execPath, [resolve('packages/relay/bin/agentmux-relay'),'serve','--config',config], {encoding:'utf8',timeout:3000});
    expect(result.status).toBe(1); expect(Date.now()-started).toBeLessThan(3000);
    expect(JSON.parse(result.stderr).error.code).toBe('MESH_STATE_IN_USE_OR_UNCONFIRMED');
  } finally {
    fault.hold = false; fault.release!();
    recovery = await recovering;
  }
  expect(recovery).toMatchObject({readbackDurability:'confirmed',identity:{epoch:1,peerId:first.peerId}});
  fault.directory = '';
  const next = await identity(path, 'after-recovery'); expect(next.identity.epoch).toBe(2); await next.release();
});
