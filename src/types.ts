export enum KeyType {
  Secp256k1 = "secp256k1",
  Ed25519 = "ed25519",
}

export interface GenerateKeyMessage {
  wallet_id: string;
  signature?: string;
}

export interface SignTxMessage {
  key_type: KeyType;
  wallet_id: string;
  network_internal_code: string;
  tx_id: string;
  tx: string;
  signature?: string;
}

export interface KeygenSuccessEvent {
  wallet_id: string;
  ecdsa_pub_key?: string;
  eddsa_pub_key?: string;
}

export enum SigningResultType {
  Unknown = 0,
  Success = 1,
  Error = 2,
}

export interface SigningResultEvent {
  wallet_id: string;
  tx_id: string;
  network_internal_code: string;
  signature: Uint8Array;
  result_type: SigningResultType;
  error_message?: string;
}
