import { connect } from "nats";
import { KeygenResultEvent, MpciumClient } from "../src";
import { computeAddress, hexlify } from "ethers";
import base58 from "bs58";
import * as fs from "fs";
import * as path from "path";
import { v4 } from "uuid";

async function main() {
  const args = process.argv.slice(2);
  const nIndex = args.indexOf("-n");
  const walletCount = nIndex !== -1 ? parseInt(args[nIndex + 1]) || 1 : 1;

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
    // password: "your-password-here",
  });

  const walletsPath = path.resolve("./wallets.json");
  let wallets: Record<string, KeygenResultEvent> = {};
  if (fs.existsSync(walletsPath)) {
    try {
      wallets = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
    } catch (error) {
      console.warn(`Could not read wallets file: ${error.message}`);
    }
  }

  let remaining = walletCount;

  mpcClient.onWalletCreationResult((event: KeygenResultEvent) => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} Received wallet creation result:`, event);
    if(event.result_type === 'error') {
      console.log(`Wallet creation failed: ${event.error_reason}`);
      return
    }
    if (event.eddsa_pub_key) {
      const pubKeyBytes = Buffer.from(event.eddsa_pub_key, "base64");
      const solanaAddress = base58.encode(pubKeyBytes);
      console.log(`Solana wallet address: ${solanaAddress}`);
    }

    if (event.ecdsa_pub_key) {
      const pubKeyBytes = Buffer.from(event.ecdsa_pub_key, "base64");
      const uncompressedKey =
        pubKeyBytes.length === 65
          ? pubKeyBytes
          : Buffer.concat([Buffer.from([0x04]), pubKeyBytes]);
      const ethAddress = computeAddress(hexlify(uncompressedKey));
      console.log(`Ethereum wallet address: ${ethAddress}`);
    }

    wallets[event.wallet_id] = event;
    fs.writeFileSync(walletsPath, JSON.stringify(wallets, null, 2));
    console.log(`Wallet saved to wallets.json with ID: ${event.wallet_id}`);

    remaining -= 1;
    if (remaining === 0) {
      console.log("All wallets generated.");
    }
  });

  try {
    for (let i = 0; i < walletCount; i++) {
      const timestamp = new Date().toISOString();
      const walletID = await mpcClient.createWallet(`${v4()}:${i}`);
      console.log(
        `${timestamp} CreateWallet sent #${
          i + 1
        }, awaiting result... walletID: ${walletID}`
      );
    }

    const shutdown = async () => {
      console.log("Cleaning up...");
      await mpcClient.cleanup();
      await nc.drain();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("Error:", error);
    await mpcClient.cleanup();
    await nc.drain();
    process.exit(1);
  }
}

main().catch(console.error);
