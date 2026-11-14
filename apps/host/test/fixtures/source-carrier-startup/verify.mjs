import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as core from "@agentmux/core";
import { AgentExecutionJournal } from "../../../../../packages/core/src/agent-execution-journal.js";
import { AgentExecutionHelperStore } from "../../../../../packages/core/src/agent-execution-helper-store.js";
const repository = resolve(import.meta.dirname, "../../../../.."),
  output = resolve(process.argv[2]),
  root = await mkdtemp(join(tmpdir(), "amx-carrier-cold-"));
await mkdir(output, { recursive: true });
const loader = resolve(import.meta.dirname, "loader.mjs"),
  children = new Set(),
  readers = new Set(),
  receipt = {
    passed: false,
    root,
    phases: [],
    limits: [
      "Actual Host index, Core source, public UnixRPC/SSH-stdio and pinned Native. System SSH and initial configuration-IO scheduling are controlled leaves. Generic Node/cat registry fixtures are not vendor semantic readiness. No production input or private production journal touched.",
    ],
  };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  quote = (x) => "'" + x.replaceAll("'", "'\\''") + "'";
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("AGENTMUX_") &&
      !key.startsWith("CTXMUX_") &&
      !key.startsWith("CARRIER_"),
  ),
);
const wait = async (read, accept, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw Error("Private test did not settle: " + label);
};
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ kind: "release-configuration" });
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }
  children.delete(child);
}
async function place(name) {
  const dir = join(root, name),
    state = join(dir, "state"),
    runtime = join(dir, "runtime"),
    home = join(dir, "home"),
    workspace = join(dir, "workspace"),
    config = join(dir, "config.json"),
    store = join(state, "sessions.json");
  for (const p of [state, runtime, home, workspace, join(state, "ctxmux")])
    await mkdir(p, { recursive: true, mode: 0o700 });
  const env = {
    ...clean,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    SHELL: join(root, "login-shell"),
    PATH: join(root, "bin") + ":" + process.env.PATH,
    AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_RUNTIME_DIRECTORY: runtime,
    AGENTMUX_AGENT_SESSION_STORE: store,
    AGENTMUX_MESSAGE_QUEUE_PATH: join(state, "messages.ndjson"),
    AGENTMUX_SPATIAL_STATE_STORE: join(state, "spatial.json"),
    AGENTMUX_HOST_CONFIGURATION_PATH: config,
    AGENTMUX_MOTE_CONFIGURATION_PATH: config,
    AGENTMUX_CONNECTOR_DIRECTORY: join(dir, "connectors"),
    AGENTMUX_MOBILE_BUILD_DIRECTORY: join(dir, "absent-mobile"),
    AGENTMUX_FAKE_SSH_HOME: home,
    CARRIER_LOADED: join(output, "loaded.ndjson"),
  };
  await writeFile(
    config,
    JSON.stringify({
      hosts: [{ id: "local", kind: "local", label: name }],
      workspaces: [
        {
          id: "original-project",
          hostId: "local",
          kind: "folder",
          name: "Original project",
          path: workspace,
        },
      ],
    }),
  );
  return {
    dir,
    state,
    runtime,
    home,
    workspace,
    config,
    store,
    env,
    socket: join(runtime, "control.sock"),
  };
}
async function native(p) {
  const child = spawn(
    resolve(
      repository,
      "packages/core/vendor/ctxmux",
      process.platform + "-" + process.arch,
      "bin/ctxmuxd",
    ),
    [
      "--socket",
      join(p.runtime, "ctxmux.sock"),
      "--state-dir",
      join(p.state, "ctxmux"),
      "--readiness-fd",
      "3",
    ],
    { env: p.env, stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  children.add(child);
  let errors = "";
  child.stderr.on("data", (v) => (errors += v));
  await Promise.race([
    once(child.stdio[3], "data"),
    once(child, "exit").then(() => {
      throw Error("Native failed: " + errors);
    }),
  ]);
  return child;
}
async function launch(p, hold = false, mutation = "") {
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      join(repository, "apps/host/src/index.ts"),
      "--store",
      p.store,
    ],
    {
      env: {
        ...p.env,
        ...(hold ? { CARRIER_HOLD_CONFIGURATION: "1" } : {}),
        ...(mutation ? { CARRIER_MUTATION: mutation } : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.add(child);
  let stdout = "",
    stderr = "",
    identity,
    held = false,
    memberRequests = 0,
    rpcEntered = [],
    rpcSettled = [],
    summaryEntered = [],
    summarySettled = [],
    routeReceipts = [];
  child.stdout.on("data", (v) => {
    stdout += v;
    for (const line of stdout.split("\n"))
      try {
        const x = JSON.parse(line);
        if (x.protocol === "jsonrpc-2.0") identity = x.owner;
      } catch {}
  });
  child.stderr.on("data", (v) => (stderr += v));
  child.on("message", (m) => {
    if (m.kind === "initial-configuration-entered") held = true;
    else if (m.kind === "original-member-carrier-requested") memberRequests++;
    else if (m.kind === "carrier-rpc-entered") rpcEntered.push(m);
    else if (m.kind === "carrier-rpc-settled") rpcSettled.push(m);
    else if (m.kind === "carrier-summary-entered") summaryEntered.push(m);
    else if (m.kind === "carrier-summary-settled") summarySettled.push(m);
    else if (m.kind === "carrier-route-receipt") routeReceipts.push(m);
  });
  await wait(
    () => {
      if (child.exitCode !== null)
        throw Error("Host exited " + child.exitCode + ": " + stderr);
      return identity;
    },
    Boolean,
    "Host publication",
  );
  if (hold) await wait(() => held, Boolean, "configuration IO held");
  const rpc = await core.connectAgentMuxRpc({
    endpoint: { transport: "unix", path: p.socket },
  });
  readers.add(rpc);
  return {
    child,
    rpc,
    identity,
    logs: () => stderr,
    memberRequests: () => memberRequests,
    rpcEntered: () => rpcEntered.slice(),
    rpcSettled: () => rpcSettled.slice(),
    summaryEntered: () => summaryEntered.slice(),
    summarySettled: () => summarySettled.slice(),
    routeReceipts: () => routeReceipts.slice(),
    release: () => child.send({ kind: "release-configuration" }),
  };
}
async function seedSession(place, sid, output, capability) {
  const names = Object.keys(place.env).filter(
    (k) => k.startsWith("AGENTMUX_") || k === "HOME" || k === "CODEX_HOME",
  );
  const saved = new Map(names.map((k) => [k, process.env[k]]));
  try {
    for (const k of names) process.env[k] = place.env[k];
    remoteClient = new core.AgentMuxClient({
      store: new core.AgentMuxFileAgentSessionStore(place.store),
    });
    await remoteClient.connect();
    const run = await remoteClient.createTerminal({
      workspacePath: place.workspace,
      command: output ? process.execPath : "/bin/cat",
      args: output
        ? [
            "-e",
            "process.stdout.write('original-native-bytes-中文');process.stdin.resume();setInterval(()=>{},1000)",
          ]
        : [],
      cols: 80,
      rows: 24,
    });
    await new core.AgentMuxFileAgentSessionStore(place.store).compareAndSwap(
      null,
      {
        kind: "agent",
        agentSessionId: sid,
        providerId: "codex",
        executorId: "codex",
        hostId: "local",
        workspacePath: place.workspace,
        run: { runId: run.runId },
        retiredRuns: [],
        hookBindingId: "private-hook",
        hookToken: "private-token",
        createdAt: 1,
        updatedAt: 1,
        ...(capability
          ? {
              capabilityHash: createHash("sha256")
                .update(capability)
                .digest("base64url"),
            }
          : {}),
      },
    );
    return run;
  } finally {
    await remoteClient?.dispose();
    remoteClient = undefined;
    for (const [k, v] of saved)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}
async function seedExecution(place, bindingId) {
  const createOperationId = bindingId + "-create",
    key = { bindingId, streamGeneration: "original-stream", nativeRequestId: 0 },
    journal = await AgentExecutionJournal.open(
      join(place.state, "agent-execution", bindingId),
    ),
    journalIdentity = journal.identity;
  let expected;
  try {
    expected = await journal.prepare(key, "original native request");
  } finally {
    await journal.close();
  }
  const input = {
      bindingId,
      role: "executor",
      providerId: "codex",
      workspacePath: place.workspace,
      createOperationId,
      grant: { scope: "host-user", bindingId },
    },
    preparation = {
      bindingId,
      role: "executor",
      providerId: "codex",
      journalIdentity,
      prepared: {
        createOperationId,
        workspacePath: place.workspace,
        launch: JSON.stringify({
          createOperationId,
          request: {
            program: process.execPath,
            args: [],
            cwd: place.workspace,
            env: { AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId },
            initial_size: { cols: 80, rows: 24 },
            declared_inputs: [],
          },
        }),
      },
    };
  await new AgentExecutionHelperStore(place.state).prepare(
    input,
    async () => preparation,
  );
  return { key, expected };
}
let remoteClient,
  sourceClient,
  originalRun,
  source,
  remote,
  sourceHost,
  remoteHost;
try {
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "login-shell"),
    '#!/bin/sh\nfor argument do script="$argument"; done\nexec /bin/sh -c "$script"\n',
    { mode: 0o700 },
  );
  await symlink(join(import.meta.dirname, "ssh.mjs"), join(root, "bin/ssh"));
  source = await place("source");
  remote = await place("remote");
  const sourceNative = await native(source),
    remoteNative = await native(remote);
  receipt.nativePids = [sourceNative.pid, remoteNative.pid];
  // Deliberate private Native Runs with explicit registry metadata; no vendor CLI enrollment.
  originalRun = await seedSession(remote, "original-carrier-member", true);
  const actorRun = await seedSession(
    source,
    "source-local-caller",
    false,
    "private-local-caller-capability",
  );
  receipt.localActor = {
    sessionId: "source-local-caller",
    runId: actorRun.runId,
    pid: actorRun.pid,
  };
  receipt.original = {
    sid: "original-carrier-member",
    cid: "original-carrier-creation",
    runId: originalRun.runId,
    pid: originalRun.pid,
  };
  const localExecution = await seedExecution(source, "source-execution-binding"),
    remoteExecution = await seedExecution(remote, "remote-execution-binding");
  remoteHost = await launch(remote);
  sourceHost = await launch(source);
  const sourceRuntime = sourceHost.identity.runtimeId,
    remoteRuntime = remoteHost.identity.runtimeId;
  let adoptedTarget, adoptedRoute, adoptedActor;
  if (process.env.CARRIER_ADOPTED_ROUTE) {
    const sourceIdentity = await sourceHost.rpc.call("route.identity", {}),
      remoteIdentity = await remoteHost.rpc.call("route.identity", {}),
      sourceChoices = await sourceHost.rpc.call("route.choices", {}),
      sourceSettings = await sourceHost.rpc.call("route.inspect", {}),
      remoteSettings = await remoteHost.rpc.call("route.inspect", {});
    adoptedActor = sourceChoices.actor;
    adoptedRoute = {
      source: sourceIdentity,
      hops: [{ edgeId: "remote-fixture", target: remoteIdentity }],
    };
    await sourceHost.rpc.call("route.configure", {
      expectedRevision: sourceSettings.revision,
      operationId: "original-adopted-route-save",
      configuration: {
        routes: [{ id: "original-adopted-route", route: adoptedRoute }],
        grants: [],
      },
    });
    await remoteHost.rpc.call("route.configure", {
      expectedRevision: remoteSettings.revision,
      operationId: "original-adopted-route-grant",
      configuration: {
        routes: [],
        grants: [{
          id: "original-adopted-route-read",
          delegator: sourceIdentity,
          actor: adoptedActor,
          destination: remoteIdentity,
          scopes: [
            "runtime.owner.identity",
            "runtime.bootstrap",
            "runtime.events",
            "runtime.attachment-watch",
            "runtime.replay-watch",
            "runtime.invoke/readAgentSession",
            "runtime.invoke/runtimeSubject",
            "runtime.invoke/resizeTerminal",
          ],
        }],
      },
    });
    const choices = await sourceHost.rpc.call("route.choices", {});
    adoptedTarget = choices.routes.find(
      (choice) => choice.id === "original-adopted-route",
    ).agentTarget;
  }
  await stop(sourceHost.child);
  sourceHost.rpc.dispose();
  readers.delete(sourceHost.rpc);
  const spatial = new core.AgentMuxSpatialStateStore(
      join(source.state, "spatial.json"),
    ),
    folder = await spatial.registerFolder({
      id: "original-project",
      hostId: "local",
      name: "Original project",
      path: source.workspace,
    }),
    reference = { runtimeId: sourceRuntime, spaceId: folder.spaceId };
  const request = {
    schemaVersion: 5,
    requestId: receipt.original.cid,
    operation: "agent.open",
    content: {
      kind: "new-agent",
      executorId: "codex",
      agentTarget: adoptedTarget ?? { hostId: "remote-fixture", runtimeId: remoteRuntime },
    },
    destination: {
      spaceId: folder.spaceId,
      zoneId: folder.zoneId,
      newTab: true,
    },
    focus: false,
  };
  const admitted = (
    await spatial.admitAgentOpen({
      request,
      agentSessionId: receipt.original.sid,
      execution: {
        hostId: adoptedTarget?.hostId ?? "remote-fixture",
        runtimeId: remoteRuntime,
        ...(adoptedRoute ? { adoptedRoute } : {}),
        executorRevision: "private-original-revision",
        workspacePath: remote.workspace,
        workspaceId: null,
      },
      placement: {
        runtimeId: sourceRuntime,
        hostId: "local",
        workspacePath: source.workspace,
        workspaceId: "original-project",
      },
      regionResource: {},
    })
  ).record;
  const originalSession = (
    await new core.AgentMuxFileAgentSessionStore(remote.store).load()
  ).find((session) => session.agentSessionId === receipt.original.sid);
  await spatial.settleAgentOpen(request.requestId, originalSession, {
    workspaceId: "original-project",
    phase: "attached",
    agentPresentation: {
      sessionId: receipt.original.sid,
      agentSessionId: receipt.original.sid,
      hostId: adoptedTarget?.hostId ?? "remote-fixture",
      runtimeId: remoteRuntime,
    },
  });
  const command = join(root, "bin/amux");
  await writeFile(
    command,
    "#!/bin/sh\nexec " +
      quote(process.execPath) +
      " --import " +
      quote(loader) +
      " " +
      quote(join(repository, "packages/core/src/agentmux.ts")) +
      ' \"$@\"\n',
    { mode: 0o700 },
  );
  const configuration = {
    hosts: [
      { id: "local", kind: "local", label: "Original source" },
      {
        id: "unrelated",
        kind: "ssh",
        label: "Unrelated unavailable",
        hostname: "pending.fixture",
        runtimeId: "unrelated-original-runtime",
      },
      {
        id: "remote-fixture",
        kind: "ssh",
        label: "Original remote",
        hostname: "original-fixture",
        remoteCommand: command,
        remoteSocketPath: remote.socket,
        runtimeId: remoteRuntime,
      },
    ],
    workspaces: [
      {
        id: "original-project",
        hostId: "local",
        kind: "folder",
        name: "Original project",
        path: source.workspace,
      },
    ],
  };
  await writeFile(source.config, JSON.stringify(configuration));
  source.env.AGENTMUX_FAKE_SSH_HOME = remote.home;
  source.env.HOST_CONFIG_SSH_TRACE = join(output, "ssh.ndjson");
  source.env.CARRIER_SSH_STDERR = join(output, "ssh.stderr");
  const target = {
    reference,
    regionId: admitted.address.regionId,
    runtimeId: remoteRuntime,
    agentSessionId: receipt.original.sid,
    expectedRun: { runId: originalRun.runId },
  };
  const graphBefore = await readFile(join(source.state, "spatial.json"));
  receipt.source = {
    runtimeId: sourceRuntime,
    reference,
    address: admitted.address,
    graphSha256: hash(graphBefore),
  };
  let originalOutputCursor = 0;
  for (let generation = 1; generation <= 2; generation++) {
    sourceHost = await launch(source, true, process.env.CARRIER_MUTATION ?? "");
    assert.equal(sourceHost.identity.runtimeId, sourceRuntime);
    const remoteEntryBaseline = remoteHost.rpcEntered().length,
      remoteSettlementBaseline = remoteHost.rpcSettled().length,
      remoteReceiptBaseline = remoteHost.routeReceipts().length,
      summaryUpdates = [],
      summaryIssues = [];
    let configurationReleased = false,
      configurationReleaseCount = 0;
    if (adoptedTarget) {
      const choices = await sourceHost.rpc.call("route.choices", {});
      assert.deepEqual(choices.actor, adoptedActor);
      assert.deepEqual(
        choices.routes.find((choice) => choice.id === "original-adopted-route")?.agentTarget,
        adoptedTarget,
        "Persisted route choices must remain locally readable during foreign configuration assembly",
      );
    }
    const summary = await core.observeSpaceSessionStates(
      sourceHost.rpc,
      { reference },
      {
        onObservation: (value) => summaryUpdates.push(value),
        onError: (error) => summaryIssues.push(error.code),
      },
    );
    readers.add(summary);
    const member = await core.connectSpaceMember(sourceHost.rpc, target);
    readers.add(member);
    let firstSettled = false,
      firstIssue;
    const first = member.metadata().then(
      (value) => {
        firstSettled = true;
        return value;
      },
      (error) => {
        firstSettled = true;
        firstIssue = error;
        throw error;
      },
    );
    first.catch(() => {});
    const second = member.metadata();
    second.catch(() => {});
    await wait(
      () => sourceHost.rpcEntered().filter((entry) => entry.method === "space.member.call").length,
      (count) => count >= 2,
      "two early original member requests reached the real Source service",
    );
    const earlyMemberEntries = sourceHost.rpcEntered()
      .filter((entry) => entry.method === "space.member.call")
      .slice(0, 2);
    assert.equal(earlyMemberEntries.length, 2);
    const earlyMemberIds = earlyMemberEntries.map((entry) => entry.requestId);
    await new Promise((done) => setTimeout(done, 120));
    const earlySettlements = sourceHost.rpcSettled().filter((entry) => earlyMemberIds.includes(entry.requestId)),
      terminalSummary = summaryUpdates.filter((value) =>
        value.type === "member" &&
        value.member?.agentSessionId === receipt.original.sid &&
        ["observed", "unavailable"].includes(value.state?.status),
      ),
      newRouteReceipts = remoteHost.routeReceipts().slice(remoteReceiptBaseline);
    assert.equal(
      earlySettlements.length,
      0,
      "Early original member read must join initial configuration assembly: " +
        JSON.stringify({ earlySettlements, firstIssue: String(firstIssue), terminalSummary, summaryIssues, routeReceipts: newRouteReceipts }),
    );
    assert.equal(
      firstSettled,
      false,
      "Early original member read must join initial configuration assembly, not fail UNKNOWN_HOST: " +
        String(firstIssue),
    );
    assert.equal(
      terminalSummary.length,
      0,
      "Original summary must remain pending before configuration release: " + JSON.stringify({ terminalSummary, summaryIssues }),
    );
    if (adoptedTarget)
      assert.equal(
        newRouteReceipts.length,
        0,
        "No remote adopted-route receipt may occur before configuration release: " + JSON.stringify(newRouteReceipts),
      );
    const managed = await core.connectAgentMuxRpc({
      endpoint: { transport: "unix", path: source.socket },
      credentials: {
        agentSessionId: "source-local-caller",
        capability: "private-local-caller-capability",
      },
    });
    readers.add(managed);
    const actorAbort = new AbortController(),
      actorTimer = setTimeout(() => actorAbort.abort(), 5000);
    let identity, identityIssue;
    try {
      identity = await managed.call(
        "whoami",
        {},
        { signal: actorAbort.signal },
      );
    } catch (error) {
      identityIssue = error.code;
    } finally {
      clearTimeout(actorTimer);
    }
    assert.equal(
      identityIssue,
      "CONTROL_CONNECTION_FAILED",
      "Local authenticated whoami must reach the absent Desktop without waiting for foreign configuration: " +
        String(identityIssue),
    );
    let whoamiCli;
    try {
      whoamiCli = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          loader,
          join(repository, "packages/core/src/agentmux.ts"),
          "--endpoint",
          "unix:" + source.socket,
          "whoami",
        ],
        {
          env: {
            ...source.env,
            AGENTMUX_AGENT_SESSION_ID: "source-local-caller",
            AGENTMUX_AGENT_CAPABILITY: "private-local-caller-capability",
          },
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    } catch (error) {
      whoamiCli = error;
    }
    assert.equal(
      JSON.parse(
        whoamiCli.stderr
          .split("\n")
          .find((line) => line.startsWith('{"ok":false')),
      ).error.code,
      "CONTROL_CONNECTION_FAILED",
    );
    const localInspection = await managed.call("agent.inspect", {
      target: { kind: "self" },
    });
    assert.equal(localInspection.session.agentSessionId, "source-local-caller");
    assert.equal(localInspection.session.run.runId, actorRun.runId);
    let managedDenial;
    await assert.rejects(
      managed.call("space.member.call", {
        target,
        call: {
          method: "runtime.owner.identity",
          params: { expectedRuntimeId: remoteRuntime },
        },
      }),
      (error) => {
        managedDenial = error.code;
        if (error.code === "AGENT_CAPABILITY_INVALID")
          assert.equal(
            error.message,
            "The runtime domain requires a transport-approved user or device, without a managed Agent caller.",
          );
        return [
          "CONTROL_PERMISSION_DENIED",
          "AGENT_CAPABILITY_INVALID",
          "HOST_ROUTE_AUTHORIZATION_REQUIRED",
        ].includes(error.code);
      },
    );
    if (adoptedTarget) assert.equal(managedDenial, "AGENT_CAPABILITY_INVALID");
    await managed.dispose();
    readers.delete(managed);
    const localOwner = await sourceHost.rpc.call("runtime.owner.identity", {});
    assert.equal(localOwner.owner.runtimeId, sourceRuntime);
    await wait(
      async () =>
        (await sourceHost.rpc.call("runtime.owner.identity", {})).owner,
      (owner) => Boolean(owner.ctxmux),
      "local Native connection independent of foreign configuration hold",
    );
    const local = await core.connectHostedAgentMux({
      rpc: sourceHost.rpc,
      connectOnDemand: true,
    });
    readers.add(local);
    const localRun = await local.createTerminal({
      workspacePath: source.workspace,
      command: "/bin/cat",
      args: [],
      cols: 80,
      rows: 24,
    });
    const localInput = "local-only\n",
      localWrite = await local.writeTerminal(
        { runId: localRun.runId },
        {
          ownerInstanceId: local.runtimeIdentity().instanceId,
          operationId: "local-proof-" + generation,
          expectedByte: 0,
          data: localInput,
        },
      );
    assert.equal(localWrite.acceptedThroughByte, Buffer.byteLength(localInput));
    await local.stopTerminal({ runId: localRun.runId });
    await local.dispose();
    readers.delete(local);
    let cancellationEvidence = null;
    if (!adoptedTarget) {
      const summaryEntryBaseline = sourceHost.summaryEntered().length,
        primarySummaryEntry = sourceHost.summaryEntered()[0];
      assert.equal(summaryEntryBaseline, 1, "The direct primary summary group read must have a real server witness");
      const secondarySummaryUpdates = [],
        secondarySummaryIssues = [],
        secondarySummary = await core.observeSpaceSessionStates(
          sourceHost.rpc,
          { reference },
          {
            onObservation: (value) => secondarySummaryUpdates.push(value),
            onError: (error) => secondarySummaryIssues.push(error.code),
          },
        );
      readers.add(secondarySummary);
      await wait(
        () => sourceHost.summaryEntered().slice(summaryEntryBaseline),
        (entries) => entries[0] ?? null,
        "secondary direct summary group read entered the real Source service",
      );
      const secondarySummaryEntry = sourceHost.summaryEntered().slice(summaryEntryBaseline)[0];
      assert(secondarySummaryEntry);
      const memberEntryBaseline = sourceHost.rpcEntered().filter((entry) => entry.method === "space.member.call").length,
        memberLookupBaseline = sourceHost.memberRequests(),
        cancel = new AbortController(),
        cancelled = sourceHost.rpc.call(
          "space.member.call",
          {
            target,
            call: {
              method: "runtime.owner.identity",
              params: { expectedRuntimeId: remoteRuntime },
            },
          },
          { signal: cancel.signal },
        ).then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
      await wait(
        () => sourceHost.rpcEntered().filter((entry) => entry.method === "space.member.call").slice(memberEntryBaseline),
        (entries) => entries[0] ?? null,
        "cancellable original lookup with a fresh member-entry baseline",
      );
      const cancelledEntry = sourceHost.rpcEntered().filter((entry) => entry.method === "space.member.call").slice(memberEntryBaseline)[0];
      assert(cancelledEntry);
      await wait(
        () => sourceHost.memberRequests(),
        (count) => count > memberLookupBaseline,
        "third direct member carrier lookup entered before cancellation",
      );
      cancel.abort();
      const cancelledOutcome = await cancelled;
      assert.equal(cancelledOutcome.error?.code, "CONTROL_CANCELLED");
      await secondarySummary.dispose();
      readers.delete(secondarySummary);
      const boundedSettlement = async (read, key, requestId, label) => {
        try {
          const entries = await wait(
            read,
            (values) => values.find((entry) => entry[key] === requestId) ?? null,
            label,
            750,
          );
          return entries.find((entry) => entry[key] === requestId) ?? null;
        } catch {
          return null;
        }
      };
      const [memberServerSettlement, summaryServerSettlement] = await Promise.all([
        boundedSettlement(
          () => sourceHost.rpcSettled(),
          "requestId",
          cancelledEntry.requestId,
          "cancelled member server settlement before configuration release",
        ),
        boundedSettlement(
          () => sourceHost.summarySettled(),
          "readId",
          secondarySummaryEntry.readId,
          "disposed secondary summary server settlement before configuration release",
        ),
      ]);
      const sharedIdentity = await sourceHost.rpc.call("runtime.owner.identity", {}),
        earlyMemberSettlementsAfterCancel = sourceHost.rpcSettled().filter((entry) => earlyMemberIds.includes(entry.requestId)),
        primarySummarySettlement = sourceHost.summarySettled().find((entry) => entry.readId === primarySummaryEntry.readId) ?? null,
        terminalSummaryAfterCancel = summaryUpdates.filter((value) =>
          value.type === "member" &&
          value.member?.agentSessionId === receipt.original.sid &&
          ["observed", "unavailable"].includes(value.state?.status),
        );
      cancellationEvidence = {
        cancelledMemberId: cancelledEntry.requestId,
        cancelledSummaryId: secondarySummaryEntry.readId,
        cancelledMemberServerSettlement: memberServerSettlement,
        cancelledSummaryServerSettlement: summaryServerSettlement,
        uncancelledMemberIds: earlyMemberIds,
        uncancelledMemberServerSettlements: earlyMemberSettlementsAfterCancel,
        primarySummaryId: primarySummaryEntry.readId,
        primarySummaryServerSettlement: primarySummarySettlement,
        primarySummaryPending: terminalSummaryAfterCancel.length === 0,
        firstMemberPending: !firstSettled,
        configurationReleased,
        sharedSocketHealthy: sharedIdentity.owner.runtimeId === sourceRuntime,
      };
      assert(
        memberServerSettlement && summaryServerSettlement,
        "Cancelled cold carrier openings must settle on the real Host before configuration release: " +
          JSON.stringify(cancellationEvidence),
      );
      assert.equal(memberServerSettlement.status, "rejected");
      assert.equal(memberServerSettlement.code, "CONTROL_CANCELLED");
      assert.equal(summaryServerSettlement.status, "rejected");
      assert.deepEqual(earlyMemberSettlementsAfterCancel, []);
      assert.equal(primarySummarySettlement, null);
      assert.equal(terminalSummaryAfterCancel.length, 0);
      assert.equal(firstSettled, false);
      assert.equal(configurationReleased, false);
      assert.equal(cancellationEvidence.sharedSocketHealthy, true);
      assert.deepEqual(secondarySummaryIssues, []);
    } else {
      const cancel = new AbortController(),
        cancelled = sourceHost.rpc.call(
          "space.member.call",
          {
            target,
            call: {
              method: "runtime.owner.identity",
              params: { expectedRuntimeId: remoteRuntime },
            },
          },
          { signal: cancel.signal },
        );
      cancelled.catch(() => {});
      await wait(
        () => sourceHost.rpcEntered().filter((entry) => entry.method === "space.member.call").length,
        (count) => count >= 3,
        "cancellable original lookup",
      );
      cancel.abort();
      await assert.rejects(cancelled);
    }
    const wrongRuntime = await core.connectSpaceMember(sourceHost.rpc, {
      ...target,
      runtimeId: "another-original-runtime",
    });
    await assert.rejects(
      wrongRuntime.metadata(),
      (error) => error.code === "SPACE_MEMBER_TARGET_MISMATCH",
    );
    await wrongRuntime.dispose();
    const localOperation = await sourceHost.rpc.call("agent.execution.inspect", {
      hostId: "local",
      ...localExecution.key,
    });
    assert.deepEqual(localOperation, localExecution.expected);
    const localContext = await sourceHost.rpc.call("agent.context", {
      hostId: "local",
      agentSessionId: "source-local-caller",
      limit: 1,
    });
    assert.equal(localContext.result?.agentSessionId ?? localContext.agentSessionId, "source-local-caller");
    let executionSettled = false,
      executionIssue;
    const executionPromise = sourceHost.rpc.call("agent.execution.inspect", {
      hostId: "remote-fixture",
      ...remoteExecution.key,
    }).then(
      (value) => {
        executionSettled = true;
        return value;
      },
      (error) => {
        executionSettled = true;
        executionIssue = error;
        throw error;
      },
    );
    executionPromise.catch(() => {});
    const cliState = { stdout: "", stderr: "", exitCode: null, signalCode: null },
      cliChild = spawn(
        process.execPath,
        [
          "--import",
          loader,
          join(repository, "packages/core/src/agentmux.ts"),
          "--endpoint",
          "unix:" + source.socket,
          "agent",
          "context",
          "--host",
          "remote-fixture",
          "--session",
          receipt.original.sid,
        ],
        { env: source.env, stdio: ["ignore", "pipe", "pipe"] },
      );
    children.add(cliChild);
    cliChild.stdout.on("data", (value) => (cliState.stdout += value));
    cliChild.stderr.on("data", (value) => (cliState.stderr += value));
    cliChild.on("exit", (code, signal) => {
      cliState.exitCode = code;
      cliState.signalCode = signal;
      children.delete(cliChild);
    });
    const exactEntries = await wait(
      () => sourceHost.rpcEntered(),
      (entries) => {
        const execution = entries.find(
            (entry) => entry.method === "agent.execution.inspect" && entry.hostId === "remote-fixture",
          ),
          context = entries.find(
            (entry) => entry.method === "agent.context" && entry.hostId === "remote-fixture",
          );
        return execution && context ? [execution, context] : null;
      },
      "exact foreign execution and context reads entered the real Source service",
    );
    await new Promise((done) => setTimeout(done, 120));
    const exactIds = exactEntries.filter((entry) =>
        (entry.method === "agent.execution.inspect" || entry.method === "agent.context") &&
        entry.hostId === "remote-fixture",
      ).map((entry) => entry.requestId),
      exactSettlements = sourceHost.rpcSettled().filter((entry) => exactIds.includes(entry.requestId));
    assert.equal(
      exactSettlements.length,
      0,
      "Exact foreign execution/context reads must join initial configuration assembly: " +
        JSON.stringify({
          exactSettlements,
          executionSettled,
          executionIssue: String(executionIssue),
          cliExitCode: cliState.exitCode,
          cliSignal: cliState.signalCode,
          cliStderr: cliState.stderr,
        }),
    );
    assert.equal(configurationReleased, false);
    configurationReleaseCount++;
    configurationReleased = true;
    sourceHost.release();
    assert.equal(configurationReleaseCount, 1);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.sessions[0].agentSessionId, receipt.original.sid);
    assert.equal(b.owner.runtimeId, remoteRuntime);
    await wait(
      () => sourceHost.rpcSettled(),
      (settlements) => earlyMemberIds.every((id) => settlements.some((entry) => entry.requestId === id && entry.status === "fulfilled")),
      "early original member reads fulfilled on the real Source service",
    );
    await wait(
      () => summaryUpdates,
      (updates) =>
        updates.some(
          (value) =>
            value.type === "member" &&
            value.member.runtimeId === remoteRuntime &&
            value.member.agentSessionId === receipt.original.sid &&
            value.state.status === "observed",
        ),
      "original Source summary reader settles after configuration handles assemble",
    );
    if (!adoptedTarget) await wait(
      () => sourceHost.summarySettled(),
      (settlements) => settlements.some((entry) => entry.readId === cancellationEvidence.primarySummaryId && entry.status === "fulfilled"),
      "uncancelled primary summary read fulfilled through shared configuration readiness",
    );
    let verifiedRouteReceipts = [];
    if (adoptedTarget) {
      await wait(
        () => remoteHost.routeReceipts(),
        (receipts) => ["runtime.owner.identity", "runtime.bootstrap", "runtime.events"].every((method) =>
          receipts.some((receipt) => receipt.method === method),
        ),
        "original adopted route reached the remote receiver",
      );
      verifiedRouteReceipts = remoteHost.routeReceipts()
        .slice(remoteReceiptBaseline)
        .filter((receipt) => ["runtime.owner.identity", "runtime.bootstrap", "runtime.events"].includes(receipt.method));
      assert(verifiedRouteReceipts.length >= 3);
      for (const routeReceipt of verifiedRouteReceipts) {
        assert.deepEqual(routeReceipt.route, adoptedRoute);
        assert.deepEqual(routeReceipt.actor, adoptedActor);
      }
    }
    assert.deepEqual(summaryIssues, []);
    const attached = await member.refreshRunAttachment(
      target.expectedRun,
      originalOutputCursor,
      "terminal",
    );
    assert.equal(attached.run.pid, originalRun.pid);
    assert.equal(attached.run.runId, originalRun.runId);
    const size = await member.resizeTerminal(
      target.expectedRun,
      generation === 1 ? 137 : 149,
      generation === 1 ? 37 : 41,
    );
    assert.deepEqual(
      [size.cols, size.rows],
      generation === 1 ? [137, 37] : [149, 41],
    );
    const subject = await member.runtimeSubject({
      kind: "agent-session",
      agentSessionId: receipt.original.sid,
    });
    assert.equal(subject.run.pid, originalRun.pid);
    assert.equal(subject.run.acceptedInputBytes, 0);
    const requestedCursor = originalOutputCursor;
    const raw = await member.readRunReplay(
      target.expectedRun,
      requestedCursor,
      "raw",
    );
    const replayed = Buffer.concat(
      raw.replay.map((chunk) => Buffer.from(chunk.dataBytes)),
    );
    if (generation === 1) {
      assert.equal(replayed.toString("utf8"), "original-native-bytes-中文");
      originalOutputCursor = raw.run.latestOutputBytes;
      assert(originalOutputCursor > 0);
    } else {
      assert.equal(
        replayed.byteLength,
        0,
        "Same original cursor does not replay old Native bytes",
      );
      assert.equal(raw.run.latestOutputBytes, originalOutputCursor);
    }
    const foreignOperation = await executionPromise;
    assert.deepEqual(foreignOperation, remoteExecution.expected);
    await wait(
      () => cliState,
      (state) => state.exitCode !== null || state.signalCode !== null,
      "original context CLI completes after carrier assembly",
    );
    assert.equal(cliState.exitCode, 0, cliState.stderr);
    const cliResult = JSON.parse(cliState.stdout);
    assert.equal(cliResult.ok, true);
    assert.equal(cliResult.operation, "agent.context");
    assert.equal(cliResult.result.hostId, "remote-fixture");
    assert.equal(cliResult.result.sourceHostId, "local");
    assert.equal(cliResult.result.agentSessionId, receipt.original.sid);
    assert.equal(cliResult.result.session.run.runId, originalRun.runId);
    assert.equal(cliResult.result.status.run.runId, originalRun.runId);
    await wait(
      () => sourceHost.rpcSettled(),
      (settlements) => exactIds.every((id) => settlements.some((entry) => entry.requestId === id && entry.status === "fulfilled")),
      "exact foreign reads fulfilled on the real Source service",
    );
    const remoteEntries = remoteHost.rpcEntered().slice(remoteEntryBaseline),
      remoteSettlements = remoteHost.rpcSettled().slice(remoteSettlementBaseline);
    for (const method of ["agent.execution.inspect", "agent.context"]) {
      assert(remoteEntries.some((entry) => entry.method === method && entry.hostId === "local"), method + " must forward local Host identity");
      assert(remoteSettlements.some((entry) => entry.method === method && entry.status === "fulfilled"), method + " must fulfill on the remote Core");
    }
    receipt.publicCli = {
      operation: cliResult.operation,
      hostId: cliResult.result.hostId,
      sessionId: cliResult.result.agentSessionId,
      runId: cliResult.result.status.run.runId,
    };
    const changed = { ...target, expectedRun: { runId: "another-run" } };
    const wrong = await core.connectSpaceMember(sourceHost.rpc, changed);
    await assert.rejects(
      wrong.metadata(),
      (error) => error.code === "STALE_AGENT_SESSION_BINDING",
    );
    await wrong.dispose();
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      sourceHost.rpc.call(
        "space.member.call",
        {
          target,
          call: {
            method: "runtime.owner.identity",
            params: { expectedRuntimeId: remoteRuntime },
          },
        },
        { signal: abort.signal },
      ),
    );
    const graphAfter = await readFile(join(source.state, "spatial.json"));
    assert.equal(
      hash(graphAfter),
      hash(graphBefore),
      "Source graph/admission must survive actual restart without reseeding",
    );
    const ssh = await readFile(join(output, "ssh.ndjson"), "utf8");
    assert(ssh.includes("pending.fixture"));
    assert(
      !ssh
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const row = JSON.parse(line);
          return (
            row.destination === "pending.fixture" && row.phase === "response"
          );
        }),
      "Unrelated handshake did not finish and must not hold the original member",
    );
    receipt.phases.push({
      generation,
      sourcePid: sourceHost.child.pid,
      sourceOwner: sourceHost.identity,
      sameRemotePid: subject.run.pid,
      grid: [size.cols, size.rows],
      acceptedInputBytes: subject.run.acceptedInputBytes,
      localInputBytes: localWrite.acceptedThroughByte,
      sourceGraphSha256: hash(graphAfter),
      originalOutput: {
        requestedCursor,
        throughByte: originalOutputCursor,
        replayBytes: replayed.byteLength,
      },
      localManagedWhoamiDuringHold:
        "authenticated; absent Desktop CONTROL_CONNECTION_FAILED",
      localManagedCliWhoamiDuringHold:
        "authenticated; absent Desktop CONTROL_CONNECTION_FAILED",
      managedForeignMemberDenial: managedDenial,
      localManagedSelfInspectionDuringHold: true,
      localOwnerAvailableDuringHold: true,
      earlyReadsJoined: true,
      earlyMemberServerIds: earlyMemberIds,
      adoptedRoute: adoptedTarget ? adoptedRoute : null,
      verifiedRouteMethods: verifiedRouteReceipts.map((routeReceipt) => routeReceipt.method),
      originalSummaryAutomaticallyObserved: true,
      configurationReleaseCount,
      cancellation: cancellationEvidence,
      guards: [
        "wrong-runtime",
        "wrong-run",
        "cancelled-original-read",
        ...(!adoptedTarget ? ["member-server-settled", "summary-server-settled", "shared-readiness-retained"] : []),
      ],
    });
    await summary.dispose();
    readers.delete(summary);
    await member.releaseRunAttachment(target.expectedRun);
    await member.dispose();
    readers.delete(member);
    await stop(sourceHost.child);
    await sourceHost.rpc.dispose();
    readers.delete(sourceHost.rpc);
    sourceHost = undefined;
  }
  receipt.passed = true;
} catch (error) {
  receipt.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  process.exitCode = 1;
} finally {
  for (const [name, host] of [
    ["source", sourceHost],
    ["remote", remoteHost],
  ])
    if (host) await writeFile(join(output, name + "-host.stderr"), host.logs());
  if (originalRun && remoteHost)
    try {
      const cleanupClient = await core.connectHostedAgentMux({
        rpc: remoteHost.rpc,
        connectOnDemand: true,
      });
      await cleanupClient.stopTerminal({ runId: originalRun.runId });
      const ended = await cleanupClient.readRunReplay(
        { runId: originalRun.runId },
        0,
        "raw",
      );
      assert.equal(ended.run.runId, originalRun.runId);
      assert.notEqual(ended.run.state, "running");
      receipt.originalRunCleanup = {
        sameRun: ended.run.runId,
        state: ended.run.state,
      };
      await cleanupClient.dispose();
    } catch (error) {
      (receipt.cleanupErrors ??= []).push(error.message);
    }
  for (const child of children)
    if (child.connected) child.send?.({ kind: "release-configuration" });
  for (const reader of readers)
    try {
      await reader.dispose();
    } catch {}
  readers.clear();
  for (const child of [...children].reverse())
    try {
      await stop(child);
    } catch (error) {
      (receipt.cleanupErrors ??= []).push(error.message);
    }
  if (remoteClient) await remoteClient.dispose().catch(() => {});
  const runPids = [originalRun?.pid, receipt.localActor?.pid].filter(
    Number.isInteger,
  );
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  try {
    await wait(
      () => runPids.filter(alive),
      (remaining) => remaining.length === 0,
      "owned Native child processes stop with private daemons",
    );
  } catch (error) {
    (receipt.cleanupErrors ??= []).push(error.message);
  }
  await rm(root, { recursive: true, force: true });
  receipt.cleanup = {
    privateRootRemoved: true,
    remainingOwnedChildren: children.size,
    ownedNativeRunPids: runPids,
    remainingOwnedNativeRunPids: runPids.filter(alive),
  };
  if (receipt.cleanupErrors?.length) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      output,
      failure: receipt.failure,
    }),
  );
}
