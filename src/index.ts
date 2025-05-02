// Export the main client class and options
export { MpciumClient, MpciumOptions } from "./client";

// Export key type enum
export { KeyType } from "./types";

// Export message and event interfaces for developers who need to work with these directly
export type {
  GenerateKeyMessage,
  SignTxMessage,
  KeygenSuccessEvent,
  SigningResultEvent,
} from "./types";

// Export utility functions for key handling
export {
  loadPrivateKey,
  signGenerateKeyMessage,
  signSignTxMessage,
} from "./utils";
