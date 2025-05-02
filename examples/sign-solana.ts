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

// The wallet ID should be provided via command line argument
const walletId = process.argv[2];
if (!walletId) {
  console.error("Please provide a wallet ID as a command line argument");
  process.exit(1);
}

// Destination wallet to send SOL to
const DESTINATION_WALLET = new PublicKey(
  "4LKprD1XvTuBupHqWXoS42XsEBHp7qALo3giDBRCNhAV"
);

// Amount to send in SOL
const AMOUNT_TO_SEND = 0.01; // 0.01 SOL

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

    // Get the public key for the wallet
    // For simplicity, let's assume we're getting it from the blockchain or some other service
    // In a real application, you would store this when the wallet is created
    const publicKeyBase64 = await getPublicKeyForWallet(walletId); // You'll need to implement this
    const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const fromPublicKey = new PublicKey(publicKeyBytes);

    console.log(`Sender account: ${fromPublicKey.toBase58()}`);
    console.log(`Destination account: ${DESTINATION_WALLET.toBase58()}`);
    console.log(`Amount to send: ${AMOUNT_TO_SEND} SOL`);

    // Create a Solana transaction to send SOL
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromPublicKey,
        toPubkey: DESTINATION_WALLET,
        lamports: LAMPORTS_PER_SOL * AMOUNT_TO_SEND,
      })
    );

    // Get the latest blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPublicKey;

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
        console.error(`Signing failed: ${event.error_message}`);
      }
    });

    // Process a successful signature
    function processSuccessfulSignature(signatureData: Uint8Array) {
      try {
        const signature = Buffer.from(signatureData);
        transaction.addSignature(fromPublicKey, signature);
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

// Helper function to get a wallet's public key
// In a real application, you would store this when the wallet is created
// or fetch it from your backend service
async function getPublicKeyForWallet(walletId: string): Promise<string> {
  // For this example, we'll use a hardcoded wallet
  // In a real application, you would fetch this from a database or API
  const exampleWallet = {
    wallet_id: "0e2ac8fb-83d1-4086-a5e6-3de7f6fe2f0a",
    ecdsa_pub_key:
      "2o3m1zdeMxy84m69JNJfgYcZHl/E7cPLchxlCwfs/ZEIEvo6EP9KKWdCkG9GeJWL+BUJbs90+8Zh7bZ1VXDeDA==",
    eddsa_pub_key: "nUA9r663eOYvKdsBhJLWAqIR1+fg+JMbGbNwiNj+69g=",
  };

  // Check if the provided walletId matches our example wallet
  if (walletId === exampleWallet.wallet_id) {
    return exampleWallet.eddsa_pub_key;
  }

  // If using for testing with a different wallet ID, you can just return the key
  // Uncomment the line below to always return the example eddsa_pub_key
  // return exampleWallet.eddsa_pub_key;

  throw new Error(
    `Wallet ID ${walletId} not found. For testing, use wallet ID: ${exampleWallet.wallet_id}`
  );
}

// Run the example
main().catch(console.error);
