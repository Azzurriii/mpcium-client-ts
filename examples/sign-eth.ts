import { connect } from "nats";
import { MpciumClient, KeyType, SigningResultEvent } from "../src";
import { ethers } from "ethers";
import { SigningResultType } from "../src/types";
import * as fs from "fs";
import * as path from "path";

// The wallet ID should be provided via command line argument
const walletId = process.argv[2];
if (!walletId) {
  console.error("Please provide a wallet ID as a command line argument");
  process.exit(1);
}

// Destination wallet to send ETH to
const DESTINATION_WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

// Amount to send in ETH
const AMOUNT_TO_SEND = "0.0001"; // 0.001 ETH

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
    // Connect to Ethereum testnet (Sepolia)
    const provider = new ethers.JsonRpcProvider(
      "https://eth-sepolia.public.blastapi.io"
    );
    console.log("Connected to Ethereum Sepolia testnet");

    // Get the wallet's public key/address
    const ethAddress = await getEthAddressForWallet(walletId);
    const fromAddress = ethAddress;

    console.log(`Sender account: ${fromAddress}`);
    console.log(`Destination account: ${DESTINATION_WALLET}`);
    console.log(`Amount to send: ${AMOUNT_TO_SEND} ETH`);

    // Get the current nonce for the sender address
    const nonce = await provider.getTransactionCount(fromAddress);

    // Get the current gas price
    const feeData = await provider.getFeeData();

    console.log("feeData:", feeData);

    // Create an Ethereum transaction
    const transaction = {
      to: DESTINATION_WALLET,
      value: ethers.parseEther(AMOUNT_TO_SEND),
      gasLimit: 21000, // Standard gas limit for ETH transfers
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      nonce: nonce,
      type: 2, // EIP-1559 transaction
      chainId: 11155111, // Sepolia chain ID
    };

    // Calculate the transaction hash (this is what needs to be signed)
    const unsignedTx = ethers.Transaction.from(transaction);
    const txHash = unsignedTx.unsignedHash;
    const txHashHex = txHash.substring(2); // Remove '0x' prefix

    console.log(`Transaction hash: ${txHash}`);

    // Subscribe to signing results
    let signatureReceived = false;
    mpcClient.onSignResult((event: SigningResultEvent) => {
      console.log("Received signing result:", event);
      signatureReceived = true;

      if (event.result_type === SigningResultType.Success) {
        processSuccessfulSignature(event);
      } else {
        console.error(`Signing failed: ${event.error_reason}`);
      }
    });

    // Process a successful signature
    function processSuccessfulSignature(event: SigningResultEvent) {
      try {
        // For ECDSA Ethereum signatures, we need the r, s, and v (recovery) values
        if (!event.r || !event.s || event.signature_recovery === null) {
          console.error("Missing signature components in result:", event);
          return;
        }

        // Convert from base64 to hex strings
        const r = "0x" + Buffer.from(event.r, "base64").toString("hex");
        const s = "0x" + Buffer.from(event.s, "base64").toString("hex");

        // Decode signature_recovery from base64 to a number
        const recoveryBuffer = Buffer.from(event.signature_recovery, "base64");
        const v = recoveryBuffer[0]; // Get the first byte as the recovery value

        console.log(`Signature components - r: ${r}, s: ${s}, v: ${v}`);

        // Create a signed transaction
        const signedTx = ethers.Transaction.from({
          ...transaction,
          signature: { r, s, v },
        });

        // Verify signature
        const recoveredAddress = signedTx.from;
        console.log(`Recovered signer: ${recoveredAddress}`);
        if (!recoveredAddress) {
          console.error("Signature verification failed!");
          return;
        }

        if (recoveredAddress.toLowerCase() !== fromAddress.toLowerCase()) {
          console.error(
            "Signature verification failed! Addresses don't match."
          );
          return;
        }

        console.log("Signature verification successful!");
        broadcastTransaction(signedTx.serialized);
      } catch (error) {
        console.error("Error processing signature:", error);
        if (error instanceof Error) {
          console.error(error.stack);
        }
      }
    }

    // Broadcast the transaction to the network
    function broadcastTransaction(signedTxHex: string) {
      provider
        .broadcastTransaction(signedTxHex)
        .then((tx) => {
          console.log(`Transaction sent! Transaction hash: ${tx.hash}`);
          console.log(
            `View transaction: https://sepolia.etherscan.io/tx/${tx.hash}`
          );
        })
        .catch((err) => {
          console.error("Error broadcasting transaction:", err);
        });
    }

    // Send the transaction hash for signing, not the serialized transaction
    const txId = await mpcClient.signTransaction({
      walletId: walletId,
      keyType: KeyType.Secp256k1,
      networkInternalCode: "ethereum:sepolia",
      tx: Buffer.from(txHashHex, "hex").toString("base64"), // Convert hex to base64
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

// Helper function to get a wallet's Ethereum address
async function getEthAddressForWallet(walletId: string): Promise<string> {
  // Load wallet from wallets.json
  const wallet = loadWallet(walletId);

  if (wallet && wallet.ecdsa_pub_key) {
    // Convert base64 public key to Ethereum address
    const pubKeyBuffer = Buffer.from(wallet.ecdsa_pub_key, "base64");
    // Convert the buffer to hex string with "0x" prefix
    const pubKeyHex = "0x" + pubKeyBuffer.toString("hex");
    // Ethereum addresses are derived from the keccak256 hash of the uncompressed public key
    const address = ethers.computeAddress(pubKeyHex);
    return address;
  }

  throw new Error(`Wallet with ID ${walletId} has no ECDSA public key`);
}

// Run the example
main().catch(console.error);
