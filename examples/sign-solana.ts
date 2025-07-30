import { connect } from "nats";
import { MpciumClient, KeyType, SigningResultEvent } from "../src";
import {
  Connection,
  Transaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { SigningResultType } from "../src/types";
import * as fs from "fs";
import * as path from "path";
import base58 from "bs58";

// The wallet ID should be provided via command line argument
const walletId = process.argv[2];
if (!walletId) {
  console.error("Please provide a wallet ID as a command line argument");
  process.exit(1);
}

// Destination wallet to send SOL to
const DESTINATION_WALLET = new PublicKey(
  "EEHqKoN2GxEPakaZhqP4hR3ZK1TPdHPsk5mntwpXzEvd"
);

// Amount to send in SOL
const AMOUNT_TO_SEND = 0.001; // 0.01 SOL

// Function to load wallet from wallets.json
function loadWallet(walletId: string) {
  const walletsPath = path.resolve("./wallets.json");
  try {
    if (fs.existsSync(walletsPath)) {
      const wallets = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
      if (wallets[walletId]) {
        return wallets[walletId];
      }
      throw new Error(`Wallet with ID ${walletId} not found in wallets.json`);
    } else {
      throw new Error("wallets.json file not found");
    }
  } catch (error) {
    console.error(`Failed to load wallet: ${error.message}`);
    process.exit(1);
  }
}

// Helper function to get a wallet's Solana address
async function getSolanaAddressForWallet(walletId: string): Promise<string> {
  // Load wallet from wallets.json
  const wallet = loadWallet(walletId);

  if (wallet && wallet.eddsa_pub_key) {
    // Convert base64 public key to Solana address (which is the base58 encoding of the public key)
    const pubKeyBuffer = Buffer.from(wallet.eddsa_pub_key, "base64");
    const solanaAddress = base58.encode(pubKeyBuffer);
    return solanaAddress;
  }

  throw new Error(`Wallet with ID ${walletId} has no EdDSA public key`);
}

async function main() {
  console.log(`Using wallet ID: ${walletId}`);

  // First, establish NATS connection separately
  const nc = await connect({ servers: "nats://localhost:4222" }).catch(
    (err) => {
      console.error(`Failed to connect to NATS: ${err.message}`);
      process.exit(1);
    }
  );
  console.log(`Connected to NATS at ${nc.getServer()}`);

  // Create client with key path
  const mpcClient = await MpciumClient.create({
    nc: nc,
    keyPath: "./event_initiator.key",
    // password: "your-password-here", // Required for .age encrypted keys
  });

  try {
    // Create a connection to Solana devnet
    const connection = new Connection(
      "https://api.devnet.solana.com",
      "confirmed"
    );
    console.log("Connected to Solana devnet");

    // Get the wallet's address
    const senderAddress = await getSolanaAddressForWallet(walletId);
    console.log(`Sender Solana address: ${senderAddress}`);

    console.log(`Destination account: ${DESTINATION_WALLET.toBase58()}`);
    console.log(`Amount to send: ${AMOUNT_TO_SEND} SOL`);

    // Create a Solana transaction to send SOL
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(senderAddress),
        toPubkey: DESTINATION_WALLET,
        lamports: LAMPORTS_PER_SOL * AMOUNT_TO_SEND,
      })
    );

    // Get the latest blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = new PublicKey(senderAddress);

    // Serialize the transaction to send it for signing
    const serializedTx = transaction.serializeMessage();
    console.log(`Transaction serialized, byte length: ${serializedTx.length}`);

    // Subscribe to signing results
    let signatureReceived = false;
    mpcClient.onSignResult((event: SigningResultEvent) => {
      console.log("Received signing result:", event);
      signatureReceived = true;

      if (event.result_type === SigningResultType.Success) {
        processSuccessfulSignature(event.signature);
      } else {
        console.error(`Signing failed: ${event.error_reason}`);
      }
    });

    // Send the transaction for signing
    const txId = await mpcClient.signTransaction({
      walletId: walletId,
      keyType: KeyType.Ed25519,
      networkInternalCode: "solana:devnet",
      tx: Buffer.from(serializedTx).toString("base64"), // Convert Uint8Array to base64 string
    });

    console.log(`Signing request sent with txID: ${txId}`);

    // Wait for the result
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (signatureReceived) {
          clearInterval(checkInterval);
          resolve(null);
        }
      }, 1000);
    });

    // Process a successful signature
    function processSuccessfulSignature(signatureData: string) {
      try {
        const signature = Buffer.from(signatureData, "base64");
        transaction.addSignature(new PublicKey(senderAddress), signature);
        if (verifyTransactionSignature()) {
          broadcastTransaction();
        }
      } catch (error) {
        console.error("Error processing signature:", error);
      }
    }

    // Verify the transaction signature
    function verifyTransactionSignature(): boolean {
      const isValid = transaction.verifySignatures();
      console.log(`Signature verification: ${isValid}`);

      if (!isValid) {
        console.error("Transaction signature verification failed!");
      }

      return isValid;
    }

    // Broadcast the transaction to the network
    function broadcastTransaction() {
      connection
        .sendRawTransaction(transaction.serialize())
        .then((txId) => {
          console.log(`Transaction sent! Transaction ID: ${txId}`);
          console.log(
            `View transaction: https://explorer.solana.com/tx/${txId}?cluster=devnet`
          );
        })
        .catch((err) => {
          console.error("Error broadcasting transaction:", err);
        });
    }
    // Keep the process running to allow time for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("Cleaning up...");
    await mpcClient.cleanup();
    await nc.drain();
  } catch (error) {
    console.error("Error:", error);
    await mpcClient.cleanup();
    await nc.drain();
    process.exit(1);
  }
}

// Run the example
main().catch(console.error);
