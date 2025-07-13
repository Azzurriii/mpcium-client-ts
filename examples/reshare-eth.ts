import { connect } from "nats";
import { MpciumClient, KeyType, ResharingResultEvent } from "../src";
import { computeAddress, hexlify } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { v4 } from "uuid";

// The wallet ID should be provided via command line argument
const walletId = process.argv[2];
if (!walletId) {
  console.error("Please provide a wallet ID as a command line argument");
  console.error("Usage: npm run reshare-eth <wallet-id>");
  process.exit(1);
}

// Example node IDs for resharing (replace with actual node IDs from your setup)
const NEW_NODE_IDS = [
  "0ce02715-0ead-48ef-9772-2583316cc860",
  "c95c340e-5a18-472d-b9b0-5ac68218213a",
  "ac37e85f-caca-4bee-8a3a-49a0fe35abff",
];

// New threshold (t+1 should be <= number of node IDs)
const NEW_THRESHOLD = 2;

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

// Helper function to get a wallet's Ethereum address
async function getEthAddressForWallet(walletId: string): Promise<string> {
  const wallet = loadWallet(walletId);

  if (!wallet.ecdsa_pub_key) {
    throw new Error(`Wallet ${walletId} does not have an ECDSA public key`);
  }

  const pubKeyBytes = Buffer.from(wallet.ecdsa_pub_key, "base64");
  const uncompressedKey =
    pubKeyBytes.length === 65
      ? pubKeyBytes
      : Buffer.concat([Buffer.from([0x04]), pubKeyBytes]);

  return computeAddress(hexlify(uncompressedKey));
}

async function main() {
  console.log(`Resharing Ethereum wallet: ${walletId}`);
  console.log(`New node IDs: ${NEW_NODE_IDS.join(", ")}`);
  console.log(`New threshold: ${NEW_THRESHOLD}`);

  // Load and display current wallet info
  const wallet = loadWallet(walletId);
  console.log("Wallet", wallet);
  const ethAddress = await getEthAddressForWallet(walletId);
  console.log(`Current Ethereum address: ${ethAddress}`);

  // Establish NATS connection
  const nc = await connect({ servers: "nats://localhost:4222" }).catch(
    (err) => {
      console.error(`Failed to connect to NATS: ${err.message}`);
      process.exit(1);
    }
  );
  console.log(`Connected to NATS at ${nc.getServer()}`);

  // Create MPC client
  const mpcClient = await MpciumClient.create({
    nc: nc,
    keyPath: "./event_initiator.key",
    // password: "your-password-here", // Uncomment if using encrypted key
  });

  // Set up result handler
  mpcClient.onResharingResult((event: ResharingResultEvent) => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} Received resharing result:`, event);

    if (event.result_type === "success") {
      console.log("✅ Resharing completed successfully!");

      if (event.pub_key) {
        // Verify the new public key generates the same Ethereum address
        try {
          const pubKeyBytes = Buffer.from(event.pub_key, "base64");
          const uncompressedKey =
            pubKeyBytes.length === 65
              ? pubKeyBytes
              : Buffer.concat([Buffer.from([0x04]), pubKeyBytes]);
          const newEthAddress = computeAddress(hexlify(uncompressedKey));

          console.log(`New public key: ${event.pub_key}`);
          console.log(`New Ethereum address: ${newEthAddress}`);

          if (newEthAddress === ethAddress) {
            console.log(
              "✅ Address verification successful - same address maintained"
            );
          } else {
            console.log("⚠️  Warning: New address differs from original");
          }
        } catch (error) {
          console.error("Failed to verify new public key:", error);
        }
      }

      // Update wallets.json with new threshold info
      updateWalletInfo(walletId, event);
    } else {
      console.log("❌ Resharing failed:");
      console.log(`Error code: ${event.error_code}`);
      console.log(`Error reason: ${event.error_reason}`);
    }
  });

  try {
    // Initiate resharing
    const sessionId = await mpcClient.reshareKeys({
      sessionId: v4(),
      walletId: walletId,
      nodeIds: NEW_NODE_IDS,
      newThreshold: NEW_THRESHOLD,
      keyType: KeyType.Secp256k1, // Ethereum uses secp256k1
    });

    console.log(`Resharing initiated with session ID: ${sessionId}`);
    console.log("Waiting for resharing to complete...");

    // Set up graceful shutdown
    const shutdown = async () => {
      console.log("Cleaning up...");
      await mpcClient.cleanup();
      await nc.drain();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Error during resharing:", error);
    await mpcClient.cleanup();
    await nc.drain();
    process.exit(1);
  }
}

// Function to update wallet info in wallets.json
function updateWalletInfo(
  walletId: string,
  reshareResult: ResharingResultEvent
) {
  const walletsPath = path.resolve("./wallets.json");
  try {
    if (fs.existsSync(walletsPath)) {
      const wallets = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
      if (wallets[walletId]) {
        // Add resharing info to the wallet
        wallets[walletId].reshare_info = {
          new_threshold: reshareResult.new_threshold,
          reshare_timestamp: new Date().toISOString(),
          session_id: reshareResult.session_id,
        };
        if (reshareResult.pub_key) {
          wallets[walletId].ecdsa_pub_key = reshareResult.pub_key;
        }
        fs.writeFileSync(walletsPath, JSON.stringify(wallets, null, 2));
        console.log("Updated wallet info in wallets.json");
      }
    }
  } catch (error) {
    console.warn(`Could not update wallets.json: ${error.message}`);
  }
}

main().catch(console.error);
