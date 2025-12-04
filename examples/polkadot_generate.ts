import { connect } from "nats";
import {
  KeygenResultEvent,
  MpciumClient,
  ed25519PubKeyToSubstrateAddress,
  POLKADOT_NETWORKS,
} from "../src";
import * as fs from "fs";
import * as path from "path";
import { v4 } from "uuid";

async function main() {
  const args = process.argv.slice(2);
  const nIndex = args.indexOf("-n");
  const walletCount = nIndex !== -1 ? parseInt(args[nIndex + 1]) || 1 : 1;

  // Optional: specify network (defaults to Paseo testnet)
  const networkIndex = args.indexOf("--network");
  const network = networkIndex !== -1 ? args[networkIndex + 1] : "paseo";

  if (!POLKADOT_NETWORKS[network]) {
    console.error(`Unknown network: ${network}`);
    console.error(
      `Available networks: ${Object.keys(POLKADOT_NETWORKS).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`Generating wallets for ${POLKADOT_NETWORKS[network].name}`);

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

  const walletsPath = path.resolve("./wallets.json");
  let wallets: Record<string, KeygenResultEvent> = {};
  if (fs.existsSync(walletsPath)) {
    try {
      wallets = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
    } catch (error) {
      console.warn(`Could not read wallets file: ${error}`);
    }
  }

  let remaining = walletCount;

  mpcClient.onWalletCreationResult((event: KeygenResultEvent) => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} Received wallet creation result:`, event);

    if (event.result_type === "error") {
      console.log(`Wallet creation failed: ${event.error_reason}`);
      return;
    }

    if (event.eddsa_pub_key) {
      const polkadotAddress = ed25519PubKeyToSubstrateAddress(
        event.eddsa_pub_key,
        POLKADOT_NETWORKS[network].ss58Prefix
      );
      console.log(
        `Polkadot wallet address (${POLKADOT_NETWORKS[network].name}): ${polkadotAddress}`
      );
    } else {
      console.warn(`Wallet ${event.wallet_id} has no EdDSA public key`);
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
