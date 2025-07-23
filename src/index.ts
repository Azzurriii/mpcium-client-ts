// Export the main client class and options
export { MpciumClient } from "./client";

// Export message and event interfaces for developers who need to work with these directly
export type {
  GenerateKeyMessage,
  SignTxMessage,
  KeygenResultEvent,
  SigningResultEvent,
  ResharingResultEvent,
  MpciumOptions,
} from "./types";

export { KeyType } from "./types";

// Export utility functions for key handling
export {
  loadPrivateKey,
  signGenerateKeyMessage,
  signSignTxMessage,
  signResharingMessage,
} from "./utils";
