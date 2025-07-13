import * as ed25519 from "@noble/ed25519";
import { readFileSync } from "fs";
import * as age from "age-encryption";
import { GenerateKeyMessage, SignTxMessage } from "./types";
import { createHash } from "crypto";
import { ResharingMessage } from "./types";

// Set up SHA-512 implementation for @noble/ed25519
ed25519.etc.sha512Sync = (...messages) => {
  const sha512 = createHash("sha512");
  for (const message of messages) {
    sha512.update(message);
  }
  return sha512.digest();
};

/**
 * Load a private key from a file path
 * @param path Path to the key file (hex encoded)
 * @returns Private key as Buffer
 */
export function loadPrivateKey(path: string): Buffer {
  try {
    const keyHex = readFileSync(path, "utf8").trim();
    return Buffer.from(keyHex, "hex");
  } catch (error) {
    throw new Error(`Failed to load private key: ${error}`);
  }
}

/**
 * Load and decrypt an Age-encrypted private key
 * @param encryptedKeyPath Path to encrypted key file
 * @param passphrase Passphrase for decryption
 * @returns Decrypted private key as Buffer
 */
export async function loadEncryptedPrivateKey(
  encryptedKeyPath: string,
  passphrase: string
): Promise<Buffer> {
  try {
    // Read the encrypted key file
    const encryptedData = readFileSync(encryptedKeyPath);

    // Create a Decrypter and add the passphrase
    const decrypter = new age.Decrypter();
    decrypter.addPassphrase(passphrase);

    // Decrypt the data and return as Buffer
    const decrypted = await decrypter.decrypt(encryptedData, "text");
    return Buffer.from(decrypted.trim(), "hex");
  } catch (error) {
    throw new Error(`Failed to decrypt key file: ${error}`);
  }
}

/**
 * Encrypt a private key with a passphrase
 * @param privateKey Private key as Buffer or hex string
 * @param passphrase Passphrase for encryption
 * @returns Encrypted data as Uint8Array
 */
export async function encryptPrivateKey(
  privateKey: Buffer | string,
  passphrase: string
): Promise<Uint8Array> {
  try {
    // Convert privateKey to hex string if it's a Buffer
    const keyHex = Buffer.isBuffer(privateKey)
      ? privateKey.toString("hex")
      : privateKey;

    // Create an Encrypter and set the passphrase
    const encrypter = new age.Encrypter();
    encrypter.setPassphrase(passphrase);

    // Encrypt the key and return
    return await encrypter.encrypt(keyHex);
  } catch (error) {
    throw new Error(`Failed to encrypt private key: ${error}`);
  }
}

/**
 * Generic function to sign a message using Ed25519 via noble-ed25519
 * @param data Data object to sign
 * @param privateKey Private key Buffer (32 bytes)
 * @returns Signature as Buffer
 */
export async function signMessage(
  data: object,
  privateKey: Buffer
): Promise<Buffer> {
  try {
    // Create canonical message format for signing
    const dataToSign = Buffer.from(JSON.stringify(data));

    // Ensure the private key is exactly 32 bytes
    if (privateKey.length !== 32) {
      throw new Error(
        `Invalid Ed25519 private key length: ${privateKey.length}, expected 32 bytes`
      );
    }

    // Convert Buffer to Uint8Array for noble-ed25519
    const privateKeyBytes = new Uint8Array(privateKey);

    // Sign the message with Ed25519
    const signature = ed25519.sign(dataToSign, privateKeyBytes);

    // Return as Buffer
    return Buffer.from(signature);
  } catch (error) {
    throw new Error(`Ed25519 signing error: ${error}`);
  }
}

/**
 * Sign a wallet generation message with Ed25519
 * @param msg Wallet generation message
 * @param privateKey Private key Buffer
 * @returns Signature as Buffer
 */
export async function signGenerateKeyMessage(
  msg: GenerateKeyMessage,
  privateKey: Buffer
): Promise<Buffer> {
  // Create data to sign - Go implementation just signs the wallet ID directly
  const dataToSign = msg.wallet_id;

  try {
    // Convert string to buffer for signing
    const dataBuffer = Buffer.from(dataToSign);

    // Ensure the private key is exactly 32 bytes
    if (privateKey.length !== 32) {
      throw new Error(
        `Invalid Ed25519 private key length: ${privateKey.length}, expected 32 bytes`
      );
    }

    // Convert Buffer to Uint8Array for noble-ed25519
    const privateKeyBytes = new Uint8Array(privateKey);

    // Sign the message with Ed25519
    const signature = ed25519.sign(dataBuffer, privateKeyBytes);

    // Return as Buffer
    return Buffer.from(signature);
  } catch (error) {
    throw new Error(`Ed25519 signing error: ${error}`);
  }
}

/**
 * Sign a transaction signing message with Ed25519
 * @param msg Transaction signing message
 * @param privateKey Private key Buffer
 * @returns Signature as Buffer
 */
export async function signSignTxMessage(
  msg: SignTxMessage,
  privateKey: Buffer
): Promise<Buffer> {
  // Create data to sign following the Go implementation
  const dataToSign = {
    key_type: msg.key_type,
    wallet_id: msg.wallet_id,
    network_internal_code: msg.network_internal_code,
    tx_id: msg.tx_id,
    tx: msg.tx,
  };

  try {
    // Create canonical message format for signing
    const dataBuffer = Buffer.from(JSON.stringify(dataToSign));

    // Ensure the private key is exactly 32 bytes
    if (privateKey.length !== 32) {
      throw new Error(
        `Invalid Ed25519 private key length: ${privateKey.length}, expected 32 bytes`
      );
    }

    // Convert Buffer to Uint8Array for noble-ed25519
    const privateKeyBytes = new Uint8Array(privateKey);

    // Sign the message with Ed25519
    const signature = ed25519.sign(dataBuffer, privateKeyBytes);

    // Return as Buffer
    return Buffer.from(signature);
  } catch (error) {
    throw new Error(`Ed25519 signing error: ${error}`);
  }
}

/**
 * Sign a resharing message
 */
export async function signResharingMessage(
  msg: ResharingMessage,
  privateKey: Buffer
): Promise<Buffer> {
  // Create message object with fields in the exact order as Go struct (excluding signature)
  const msgWithoutSignature = {
    session_id: msg.session_id,
    node_ids: msg.node_ids,
    new_threshold: msg.new_threshold,
    key_type: msg.key_type,
    wallet_id: msg.wallet_id,
  };
  
  const messageBuffer = Buffer.from(JSON.stringify(msgWithoutSignature));
  const privateKeyBytes = new Uint8Array(privateKey);
  return Buffer.from(ed25519.sign(messageBuffer, privateKeyBytes));
}
