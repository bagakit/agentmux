// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Vendored from Paseo 3c6e4e39ec57fc1ecec35cd848ba259893d5e298; see LICENSE and NOTICE.
export type { ConnectionRole, RelaySessionAttachment } from "./types.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

export {
  base64EncryptedWireByteLength,
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  maxBase64EncryptedPlaintextByteLength,
} from "./encrypted-channel.js";
export type { Transport, EncryptedChannelEvents } from "./encrypted-channel.js";
