import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFrame } from "./fixtures/toolkit-frame/capture.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/u, "");
const [flag, directory, ...remaining] = process.argv.slice(2);
assert.ok(flag === "--evidence" && directory && isAbsolute(directory),
  "Usage: node apps/desktop/scripts/capture-toolkit-pending-launch.mjs --evidence /absolute/path [--mutation stop-options|release-options]");
assert.ok(remaining.length === 0 || remaining.length === 2 && remaining[0] === "--mutation" && ["stop-options", "release-options"].includes(remaining[1]));
const receipt = await captureFrame({ root, evidence: resolve(directory), scope: "pending-launch", mutation: remaining[1] ?? null });
console.log(JSON.stringify({
  evidence: directory,
  passed: receipt.completed,
  specificAssertionRED: receipt.specificAssertionRED ?? false,
  frames: receipt.frames.map(({ name }) => name),
  sourceIdentity: receipt.sourceIdentity,
}));
