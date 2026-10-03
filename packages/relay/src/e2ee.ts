// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Vendored from Paseo 3c6e4e39ec57fc1ecec35cd848ba259893d5e298; see LICENSE and NOTICE.
export { createClientChannel, createDaemonChannel, EncryptedChannel } from "./encrypted-channel.js";
export type { Transport, TransportMessage, EncryptedChannelEvents } from "./encrypted-channel.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
} from "./crypto.js";
export type { KeyPair, SharedKey } from "./crypto.js";
