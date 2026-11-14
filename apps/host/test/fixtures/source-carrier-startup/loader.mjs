import { registerHooks, createRequire } from "node:module";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const repository = resolve(import.meta.dirname, "../../../../.."),
  core = resolve(repository, "packages/core");
const require = createRequire(resolve(repository, "apps/desktop/package.json")),
  ts = require("typescript");
const manifest = JSON.parse(
  readFileSync(resolve(core, "package.json"), "utf8"),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
let release,
  entered = false;
const held = new Promise((done) => {
  release = done;
});
process.on("message", (message) => {
  if (message?.kind === "release-configuration") release();
});
globalThis.__holdOriginalCarrierConfiguration = async () => {
  if (!process.env.CARRIER_HOLD_CONFIGURATION || entered) return;
  entered = true;
  process.send?.({ kind: "initial-configuration-entered" });
  await held;
};
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "@agentmux/core" ||
      specifier.startsWith("@agentmux/core/")
    ) {
      const key =
        specifier === "@agentmux/core"
          ? "."
          : "./" + specifier.slice("@agentmux/core/".length);
      const entry = manifest.exports[key],
        target = typeof entry === "string" ? entry : entry?.import;
      if (target) {
        const source = resolve(
          core,
          target.replace("./dist/", "./src/").replace(/\.js$/, ".ts"),
        );
        if (existsSync(source))
          return { url: pathToFileURL(source).href, shortCircuit: true };
      }
    }
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const source = fileURLToPath(
        new URL(specifier, context.parentURL),
      ).replace(/\.js$/, ".ts");
      if (
        (source.startsWith(core + "/src/") ||
          source.startsWith(resolve(repository, "apps/host/src") + "/")) &&
        existsSync(source)
      )
        return { url: pathToFileURL(source).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts"))
      return next(url, context);
    const file = fileURLToPath(url),
      original = readFileSync(file, "utf8"),
      path = relative(repository, file);
    let controlled = original,
      served;
    if (path === "apps/host/src/configured-host-clients.ts") {
      const anchor = "    let value: unknown\n";
      if (original.split(anchor).length !== 2)
        throw Error("Configuration IO fixture must match one original owner");
      controlled = original.replace(
        anchor,
        anchor +
          "    await (globalThis as any).__holdOriginalCarrierConfiguration()\n",
      );
    }
    if (path === "packages/core/src/space-member-runtime.ts") {
      const anchor =
        "    const matches = (await ports.clients(initial.hostId)).filter";
      if (original.split(anchor).length !== 2)
        throw Error("Member request witness must bind one original lookup");
      controlled = original.replace(
        anchor,
        "    process.send?.({kind:'original-member-carrier-requested'})\n" +
          anchor,
      );
    }
    if (path === "packages/core/src/public-rpc-wire.ts") {
      const anchor =
        "          } else result = await this.service.call(method, params as AgentMuxRpcParams<typeof method>, context)\n";
      if (original.split(anchor).length !== 2)
        throw Error("Public RPC witness must bind one finite dispatcher");
      controlled = original.replace(
        anchor,
        "          } else {\n" +
          "            const witnessed = method === 'space.member.call' || method === 'agent.execution.inspect' || method === 'agent.context'\n" +
          "            if (witnessed) process.send?.({kind:'carrier-rpc-entered',method,requestId:request.id ?? null,hostId:(params as any).hostId ?? null})\n" +
          "            try {\n" +
          "              result = await this.service.call(method, params as AgentMuxRpcParams<typeof method>, context)\n" +
          "              if (witnessed) process.send?.({kind:'carrier-rpc-settled',method,requestId:request.id ?? null,status:'fulfilled'})\n" +
          "            } catch (error) {\n" +
          "              if (witnessed) process.send?.({kind:'carrier-rpc-settled',method,requestId:request.id ?? null,status:'rejected',code:(error as any)?.code})\n" +
          "              throw error\n" +
          "            }\n" +
          "          }\n",
      );
    }
    if (path === "packages/core/src/host-route-gateway.ts") {
      const anchor =
        "    try { await authority.current(); return { envelope, call, authority } }\n";
      if (original.split(anchor).length !== 2)
        throw Error("Route receipt witness must bind one receiving authority");
      controlled = original.replace(
        anchor,
        "    try { await authority.current(); process.send?.({kind:'carrier-route-receipt',method:call.method,route:statement.route,actor:statement.actor}); return { envelope, call, authority } }\n",
      );
    }
    served = controlled;
    if (
      process.env.CARRIER_MUTATION === "omit-readiness" &&
      path === "apps/host/src/host.ts"
    ) {
      const anchor =
        "        if (hostId !== undefined && hostId !== 'local') await options.connections!.clientsReady?.()";
      if (served.split(anchor).length !== 2)
        throw Error(
          "Readiness mutant must match actual Host bridge exactly once",
        );
      served = served.replace(anchor, "");
    }
    if (
      process.env.CARRIER_MUTATION === "global-readiness" &&
      path === "apps/host/src/host.ts"
    ) {
      const anchor =
        "if (hostId !== undefined && hostId !== 'local') await options.connections!.clientsReady?.()";
      if (served.split(anchor).length !== 2)
        throw Error(
          "Global readiness mutant must match original exact selector",
        );
      served = served.replace(
        anchor,
        "await options.connections!.clientsReady?.()",
      );
    }
    if (
      process.env.CARRIER_MUTATION === "omit-route-readiness" &&
      path === "apps/host/src/configured-host-clients.ts"
    ) {
      const anchor = "      await refresh()\n";
      if (served.split(anchor).length !== 2)
        throw Error("Route readiness mutant must match one initial refresh");
      served = served.replace(anchor, "      void refresh()\n");
    }
    const record = {
      file: path,
      pid: process.pid,
      originalSha256: hash(original),
      controlledSha256: hash(controlled),
      servedSha256: hash(served),
      configurationIoLeaf: path === "apps/host/src/configured-host-clients.ts",
      memberRequestWitness:
        path === "packages/core/src/space-member-runtime.ts",
      publicWireWitness: path === "packages/core/src/public-rpc-wire.ts",
      routeReceiptWitness: path === "packages/core/src/host-route-gateway.ts",
      mutation: served !== controlled ? process.env.CARRIER_MUTATION : null,
    };
    const prefix = process.env.CARRIER_LOADED
      ? `import {appendFileSync as __carrierLoaded} from 'node:fs';__carrierLoaded(${JSON.stringify(process.env.CARRIER_LOADED)},${JSON.stringify(JSON.stringify(record) + "\n")});\n`
      : "";
    const emitted = ts.transpileModule(served, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        esModuleInterop: true,
        isolatedModules: true,
      },
    }).outputText;
    const offset = emitted.startsWith("#!") ? emitted.indexOf("\n") + 1 : 0;
    return {
      format: "module",
      shortCircuit: true,
      source: emitted.slice(0, offset) + prefix + emitted.slice(offset),
    };
  },
});
