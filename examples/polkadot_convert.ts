import { ed25519PubKeyToSubstrateAddress, POLKADOT_NETWORKS } from "../src";
import fs from "fs";
import { KeygenResultEvent } from "../src/types";

// Convert all wallets to Polkadot addresses (Westend testnet)
const wallets = JSON.parse(fs.readFileSync("./wallets.json", "utf8"));
for (const [walletId, wallet] of Object.entries(wallets) as [string, KeygenResultEvent][]) {
  if (!wallet.eddsa_pub_key) {
    console.warn(`Wallet ${walletId} has no EdDSA public key`);
    continue;
  }
  const address = ed25519PubKeyToSubstrateAddress(
    wallet.eddsa_pub_key,
    POLKADOT_NETWORKS.westend.ss58Prefix
  );
  console.log(`${walletId}: ${address}`);
}