import { connect } from "nats";
import {
  MpciumClient,
  KeyType,
  SigningResultEvent,
  buildNativeTransferPayload,
  submitSignedExtrinsic,
  ed25519PubKeyToSubstrateAddress,
  getNetworkCode,
  POLKADOT_NETWORKS,
} from "../src";
import { SigningResultType } from "../src/types";
import * as fs from "fs";
import * as path from "path";
import { u8aToHex } from "@polkadot/util";

const walletId = process.argv[2];
if (!walletId) {
  console.error("Usage: npx ts-node examples/sign-polkadot.ts <wallet_id>");
  process.exit(1);
}

// Configuration
const NETWORK = "westend"; // Use Westend testnet
const DESTINATION_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // Alice on Westend
const AMOUNT = BigInt(100_000_000_000); // 0.1 WND (10^12 planck = 1 WND)

function loadWallet(walletId: string) {
  const walletsPath = path.resolve("./wallets.json");
  if (!fs.existsSync(walletsPath)) {
    throw new Error("wallets.json file not found");
  }
  const wallets = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
  if (!wallets[walletId]) {
    throw new Error(`Wallet with ID ${walletId} not found in wallets.json`);
  }
  return wallets[walletId];
}

async function main() {
  console.log(`Using wallet ID: ${walletId}`);
  console.log(`Network: ${POLKADOT_NETWORKS[NETWORK].name}`);

  const nc = await connect({ servers: "nats://localhost:4222" }).catch(
    (err) => {
      console.error(`Failed to connect to NATS: ${err.message}`);
      process.exit(1);
    }
  );
  console.log(`Connected to NATS at ${nc.getServer()}`);

  const mpcClient = await MpciumClient.create({
    nc: nc,
    keyPath: "./event_initiator.key",
  });

  try {
    const wallet = loadWallet(walletId);
    if (!wallet.eddsa_pub_key) {
      throw new Error(`Wallet ${walletId} has no EdDSA public key`);
    }

    const senderAddress = ed25519PubKeyToSubstrateAddress(
      wallet.eddsa_pub_key,
      POLKADOT_NETWORKS[NETWORK].ss58Prefix
    );
    console.log(`Sender address: ${senderAddress}`);
    console.log(`Destination: ${DESTINATION_ADDRESS}`);
    console.log(`Amount: ${AMOUNT} planck`);

    // Build the signing payload
    console.log("\nBuilding signing payload...");
    const payloadResult = await buildNativeTransferPayload({
      mpcAddress: senderAddress,
      destinationAddress: DESTINATION_ADDRESS,
      amount: AMOUNT,
      network: NETWORK,
      keepAlive: true,
    });

    console.log(`Payload hex: ${payloadResult.payloadHex}`);
    console.log(`Payload length: ${payloadResult.payloadBytes.length} bytes`);

    // Subscribe to signing results
    let signatureReceived = false;
    let signatureHex: string | null = null;

    mpcClient.onSignResult(async (event: SigningResultEvent) => {
      console.log("\nReceived signing result:", event);
      signatureReceived = true;

      if (event.result_type === SigningResultType.Success) {
        const sigBytes = Buffer.from(event.signature, "base64");
        signatureHex = u8aToHex(sigBytes);
        console.log(`Signature: ${signatureHex}`);

        try {
          console.log("\nSubmitting signed extrinsic...");
          const result = await submitSignedExtrinsic({
            api: payloadResult.api,
            extrinsic: payloadResult.extrinsic,
            signatureHex: signatureHex,
            mpcAddress: senderAddress,
          });

          console.log(`\nTransaction submitted!`);
          console.log(`  TX Hash: ${result.txHash}`);
          console.log(`  Status: ${result.status}`);
          if (result.blockHash) {
            console.log(`  Block: ${result.blockHash}`);
          }
          console.log(
            `\nView on Subscan: https://westend.subscan.io/extrinsic/${result.txHash}`
          );
        } catch (err) {
          console.error("Failed to submit extrinsic:", err);
        }
      } else {
        console.error(`Signing failed: ${event.error_reason}`);
      }
    });

    // Send the payload for MPC signing
    const txId = await mpcClient.signTransaction({
      walletId: walletId,
      keyType: KeyType.Ed25519,
      networkInternalCode: getNetworkCode(NETWORK),
      tx: Buffer.from(payloadResult.payloadBytes).toString("base64"),
    });

    console.log(`\nSigning request sent with txID: ${txId}`);

    // Wait for the result
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (signatureReceived) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });

    // Allow time for transaction confirmation
    await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log("\nCleaning up...");
    await payloadResult.api.disconnect();
    await mpcClient.cleanup();
    await nc.drain();
  } catch (error) {
    console.error("Error:", error);
    await mpcClient.cleanup();
    await nc.drain();
    process.exit(1);
  }
}

main().catch(console.error);

