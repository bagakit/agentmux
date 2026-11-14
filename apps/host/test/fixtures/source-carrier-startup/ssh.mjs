#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const stderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (value, ...rest) => {
  if (process.env.CARRIER_SSH_STDERR)
    appendFileSync(process.env.CARRIER_SSH_STDERR, value);
  return stderr(value, ...rest);
};
await import("../host-configuration-ssh.mjs");
