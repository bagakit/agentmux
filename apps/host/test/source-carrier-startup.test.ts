import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
const exec = promisify(execFile),
  repository = resolve(import.meta.dirname, "../../..");
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function verify(name: string, mutation?: string, adoptedRoute = false) {
  const output = process.env.CARRIER_EVIDENCE_ROOT
    ? resolve(process.env.CARRIER_EVIDENCE_ROOT, name)
    : await mkdtemp(join(tmpdir(), "amx-carrier-evidence-"));
  if (!process.env.CARRIER_EVIDENCE_ROOT) temporary.push(output);
  let exitCode = 0,
    stdout = "",
    stderr = "";
  try {
    const result = await exec(
      process.execPath,
      [
        "--import",
        "./apps/host/test/fixtures/source-carrier-startup/loader.mjs",
        "./apps/host/test/fixtures/source-carrier-startup/verify.mjs",
        output,
      ],
      {
        cwd: repository,
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          ...(mutation ? { CARRIER_MUTATION: mutation } : {}),
          ...(adoptedRoute ? { CARRIER_ADOPTED_ROUTE: "1" } : {}),
        },
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const result = error as { code: number; stdout?: string; stderr?: string };
    exitCode = result.code;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  }
  await writeFile(
    join(output, "invocation.json"),
    JSON.stringify({ exitCode, stdout, stderr }, null, 2) + "\n",
  );
  const receipt = JSON.parse(
    await readFile(join(output, "receipt.json"), "utf8"),
  );
  const loaded = (await readFile(join(output, "loaded.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  return { exitCode, stdout, stderr, receipt, loaded };
}
it("actual Host cold source assembly joins early original member reads across process restart without waiting for unrelated SSH", async () => {
  const result = await verify("candidate");
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.receipt.passed, JSON.stringify(result.receipt.failure)).toBe(
    true,
  );
  expect(result.receipt.phases).toHaveLength(2);
  expect(
    new Set(
      result.receipt.phases.map(
        (phase: { sourcePid: number }) => phase.sourcePid,
      ),
    ).size,
  ).toBe(2);
  expect(
    result.receipt.phases.every(
      (phase: { sameRemotePid: number; acceptedInputBytes: number }) =>
        phase.sameRemotePid === result.receipt.original.pid &&
        phase.acceptedInputBytes === 0,
    ),
  ).toBe(true);
  expect(
    result.receipt.phases.every(
      (phase: {
        localManagedSelfInspectionDuringHold: boolean;
        managedForeignMemberDenial: string;
      }) =>
        phase.localManagedSelfInspectionDuringHold === true &&
        [
          "HOST_ROUTE_AUTHORIZATION_REQUIRED",
          "AGENT_CAPABILITY_INVALID",
          "CONTROL_PERMISSION_DENIED",
        ].includes(phase.managedForeignMemberDenial),
    ),
  ).toBe(true);
  for (const phase of result.receipt.phases) {
    expect(phase.configurationReleaseCount).toBe(1);
    expect(phase.cancellation).toMatchObject({
      cancelledMemberServerSettlement: { status: "rejected", code: "CONTROL_CANCELLED" },
      cancelledSummaryServerSettlement: { status: "rejected", code: 20 },
      secondarySummaryPendingBeforeDispose: true,
      secondarySummarySettlementBeforeDispose: null,
      secondarySummaryTerminalBeforeDispose: [],
      uncancelledMemberServerSettlements: [],
      primarySummaryServerSettlement: null,
      primarySummaryPending: true,
      firstMemberPending: true,
      configurationReleased: false,
      sharedSocketHealthy: true,
    });
    expect(phase.guards).toEqual(
      expect.arrayContaining([
        "member-server-settled",
        "summary-server-settled",
        "shared-readiness-retained",
      ]),
    );
    const sourceLoaded = result.loaded.filter(
      (entry: { pid: number }) => entry.pid === phase.sourcePid,
    );
    for (const witness of [
      "memberRequestWitness",
      "publicWireWitness",
      "summaryGroupWitness",
    ]) {
      expect(
        sourceLoaded.some(
          (entry: Record<string, unknown>) =>
            entry[witness] === true &&
            entry.originalSha256 !== entry.controlledSha256,
        ),
        `actual Source PID ${phase.sourcePid} must load the ${witness} source witness`,
      ).toBe(true);
    }
  }
  expect(result.receipt.cleanup).toMatchObject({
    remainingOwnedNativeRunPids: [],
    privateRootRemoved: true,
    remainingOwnedChildren: 0,
  });
}, 190000);
it("an early secondary summary rejection cannot masquerade as disposal cancellation", async () => {
  const result = await verify("early-summary-rejection", "early-summary-rejection");
  expect(result.exitCode).not.toBe(0);
  expect(result.receipt.failure).toMatchObject({ name: "AssertionError" });
  expect(result.receipt.failure.message).toContain(
    "Secondary summary must remain unsettled until disposal",
  );
  expect(result.receipt.failure.message).toContain("UNKNOWN_HOST");
  expect(
    result.loaded.some(
      (entry: {
        file: string;
        mutation: string;
        controlledSha256: string;
        servedSha256: string;
      }) =>
        entry.file === "packages/core/src/space-session-client.ts" &&
        entry.mutation === "early-summary-rejection" &&
        entry.controlledSha256 !== entry.servedSha256,
    ),
  ).toBe(true);
  expect(result.receipt.cleanup).toMatchObject({
    remainingOwnedNativeRunPids: [],
    privateRootRemoved: true,
    remainingOwnedChildren: 0,
  });
}, 190000);
it("actual Host cold adopted routes join member, summary and execution reads before carrier use", async () => {
  const control = await verify("adopted-route", undefined, true);
  expect(control.exitCode, control.stdout + control.stderr).toBe(0);
  expect(control.receipt.passed, JSON.stringify(control.receipt.failure)).toBe(true);
  expect(control.receipt.phases).toHaveLength(2);
  for (const phase of control.receipt.phases) {
    expect(phase.earlyMemberServerIds).toHaveLength(2);
    expect(phase.adoptedRoute.hops[0].edgeId).toBe("remote-fixture");
    expect(phase.verifiedRouteMethods).toEqual(
      expect.arrayContaining(["runtime.owner.identity", "runtime.bootstrap", "runtime.events"]),
    );
  }
  expect(control.loaded.some((entry: { publicWireWitness?: boolean }) => entry.publicWireWitness)).toBe(true);
  expect(control.loaded.some((entry: { routeReceiptWitness?: boolean }) => entry.routeReceiptWitness)).toBe(true);
  expect(control.receipt.cleanup).toMatchObject({
    remainingOwnedNativeRunPids: [],
    privateRootRemoved: true,
    remainingOwnedChildren: 0,
  });

  const mutant = await verify("adopted-route-omit", "omit-route-readiness", true);
  expect(mutant.exitCode).not.toBe(0);
  expect(mutant.receipt.failure).toMatchObject({ name: "AssertionError" });
  expect(mutant.receipt.failure.message).toContain("Early original member read must join initial configuration assembly");
  expect(mutant.receipt.failure.message).toContain("HOST_ROUTE_EDGE_UNAVAILABLE");
  expect(
    mutant.loaded.some(
      (entry: {
        file: string;
        mutation: string;
        controlledSha256: string;
        servedSha256: string;
      }) =>
        entry.file === "apps/host/src/configured-host-clients.ts" &&
        entry.mutation === "omit-route-readiness" &&
        entry.controlledSha256 !== entry.servedSha256,
    ),
  ).toBe(true);
  expect(mutant.receipt.cleanup).toMatchObject({
    remainingOwnedNativeRunPids: [],
    privateRootRemoved: true,
    remainingOwnedChildren: 0,
  });
}, 380000);
it("a loaded omission of the Host readiness join reproduces the original early-reader failure semantically", async () => {
  const result = await verify("omit-readiness", "omit-readiness");
  expect(result.exitCode).not.toBe(0);
  expect(result.receipt.failure).toMatchObject({ name: "AssertionError" });
  expect(result.receipt.failure.message).toContain(
    "Early original member read must join initial configuration assembly",
  );
  expect(
    result.loaded.some(
      (entry: {
        file: string;
        mutation: string;
        controlledSha256: string;
        servedSha256: string;
      }) =>
        entry.file === "apps/host/src/host.ts" &&
        entry.mutation === "omit-readiness" &&
        entry.controlledSha256 !== entry.servedSha256,
    ),
  ).toBe(true);
  expect(result.receipt.cleanup).toMatchObject({
    remainingOwnedNativeRunPids: [],
    privateRootRemoved: true,
    remainingOwnedChildren: 0,
  });
}, 190000);

it("a loaded global readiness gate cannot withhold local managed authentication for an unrelated foreign configuration", async () => {
  const result = await verify("global-readiness", "global-readiness");
  expect(result.exitCode).not.toBe(0);
  expect(result.receipt.failure).toMatchObject({ name: "AssertionError" });
  expect(result.receipt.failure.message).toContain(
    "Local authenticated whoami must reach the absent Desktop without waiting for foreign configuration",
  );
  expect(
    result.loaded.some(
      (entry: {
        file: string;
        mutation: string;
        controlledSha256: string;
        servedSha256: string;
      }) =>
        entry.file === "apps/host/src/host.ts" &&
        entry.mutation === "global-readiness" &&
        entry.controlledSha256 !== entry.servedSha256,
    ),
  ).toBe(true);
  expect(result.receipt.cleanup).toMatchObject({
    remainingOwnedNativeRunPids: [],
    privateRootRemoved: true,
    remainingOwnedChildren: 0,
  });
}, 190000);
