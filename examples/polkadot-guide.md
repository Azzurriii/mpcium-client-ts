# Polkadot/Substrate Testing Guide

## Prerequisites

1. **MPC nodes running**: Ensure your MPC nodes are running and connected to NATS
2. **NATS connection**: NATS should be accessible at `localhost:4222`
3. **Event initiator key**: File `examples/event_initiator.key` must exist

---

## Step 1: Create a Wallet

**Command:**
```bash
cd mpcium-client-ts
npx ts-node examples/generate.ts
```

**What happens:**
- Connects to NATS
- Creates a new MPC wallet with both ECDSA and EdDSA keys
- Saves wallet to `wallets.json` in the project root
- Displays wallet ID, Solana address, and Ethereum address

**Expected output:**
```
Connected to NATS at localhost:4222
CreateWallet sent, awaiting result... walletID: <uuid>
Received wallet creation result: { wallet_id: "...", eddsa_pub_key: "...", ... }
Solana wallet address: <address>
Ethereum wallet address: <address>
Wallet saved to wallets.json with ID: <wallet_id>
```

**Note:** Copy the `wallet_id` from the output - you'll need it for the next steps.

---

## Step 2: Get Your Polkadot Address

**Command:**
```bash
npx ts-node examples/polkadot_convert.ts
```

**What happens:**
- Reads all wallets from `wallets.json`
- Converts each wallet's EdDSA public key to a Polkadot address (Westend testnet)
- Displays wallet ID and corresponding Polkadot address

**Expected output:**
```
<wallet_id>: 5<substrate_address>
```

**Note:** Copy your Polkadot address - you'll need it to receive test tokens.

---

## Step 3: Fund Your Wallet (Get Test Tokens)

**For Westend Testnet:**
1. Visit [Westend Faucet](https://matrix.to/#/#westend_faucet:matrix.org) or [Substrate Faucet](https://www.substrate.io/substrate-faucet/)
2. Request test tokens (WND) using your Polkadot address from Step 2
3. Wait for confirmation (usually a few minutes)

**Alternative:** Use Polkadot.js Apps:
1. Go to https://polkadot.js.org/apps/?rpc=wss://westend-rpc.polkadot.io
2. Connect with your address
3. Use the faucet if available

---

## Step 4: Send Native Token (Relay Chain Transfer)

**Command:**
```bash
npx ts-node examples/sign-polkadot.ts <wallet_id>
```

**Replace `<wallet_id>`** with the wallet ID from Step 1.

**What happens:**
1. Connects to NATS and Westend network
2. Builds a transfer transaction (0.1 WND to Alice address)
3. Sends signing request to MPC nodes
4. Waits for MPC signature
5. Submits signed transaction to Westend
6. Displays transaction hash and block information

**Expected output:**
```
Using wallet ID: <wallet_id>
Network: Westend
Sender address: <your_address>
Destination: 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
Amount: 100000000000 planck

Building signing payload...
Payload hex: 0x...
Payload length: <bytes> bytes

Signing request sent with txID: <tx_id>
Received signing result: { ... }
Signature: 0x...

Submitting signed extrinsic...

Transaction submitted!
  TX Hash: 0x...
  Status: inBlock
  Block: 0x...

View on Subscan: https://westend.subscan.io/extrinsic/<tx_hash>
```

**Verify:** Check the transaction on [Westend Subscan](https://westend.subscan.io/)

---

## Step 5: Send Asset Hub Token (Asset Transfer)

**Command:**
```bash
npx ts-node examples/sign-polkadot-asset-hub.ts <wallet_id> <asset_id>
```

**Replace:**
- `<wallet_id>` with your wallet ID from Step 1
- `<asset_id>` with the asset ID you want to transfer (e.g., `1984`)

**What happens:**
1. Connects to NATS and Asset Hub Westend network
2. Builds an asset transfer transaction
3. Sends signing request to MPC nodes
4. Waits for MPC signature
5. Submits signed transaction to Asset Hub
6. Displays transaction hash

**Expected output:**
```
Using wallet ID: <wallet_id>
Network: Asset Hub (Westend)
Asset ID: <asset_id>
Sender address: <your_address>
Destination: 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
Amount: <amount> (asset units)

Building asset transfer payload...
Payload hex: 0x...

Signing request sent with txID: <tx_id>
Received signing result: { ... }

Transaction submitted!
  TX Hash: 0x...
  Status: inBlock
  Block: 0x...

View on Subscan: https://assethub-westend.subscan.io/extrinsic/<tx_hash>
```

**Note:** You need to have the asset in your wallet before transferring. Asset Hub uses different asset IDs than the relay chain.

---

## Troubleshooting

### Error: "Failed to connect to NATS"
- **Fix:** Ensure NATS server is running: `nats-server` or check your MPC nodes are running

### Error: "Wallet not found"
- **Fix:** Make sure `wallets.json` exists in the project root and contains your wallet ID

### Error: "Insufficient balance"
- **Fix:** Fund your wallet with test tokens from the faucet (Step 3)

### Error: "Event initiator key not found"
- **Fix:** Ensure `examples/event_initiator.key` exists. If using encrypted key, add `password` parameter in the script.

### Transaction stuck or slow
- **Fix:** Check network connectivity. Westend can be slow during high traffic. Wait a few minutes and check Subscan.

---

## Quick Reference

| Task | Command |
|------|---------|
| Create wallet | `npx ts-node examples/generate.ts` |
| Get Polkadot address | `npx ts-node examples/polkadot_convert.ts` |
| Send native token | `npx ts-node examples/sign-polkadot.ts <wallet_id>` |
| Send asset token | `npx ts-node examples/sign-polkadot-asset-hub.ts <wallet_id> <asset_id>` |

## Supported Networks

**Relay Chains:**
- `westend` - Westend testnet (recommended for testing)
- `polkadot` - Polkadot mainnet
- `kusama` - Kusama mainnet
- `rococo` - Rococo testnet

**Asset Hubs:**
- `asset-hub-westend` - Asset Hub on Westend
- `asset-hub-polkadot` - Asset Hub on Polkadot
- `asset-hub-kusama` - Asset Hub on Kusama

---

## What to Expect

- **Wallet creation:** Takes 5-30 seconds depending on MPC node configuration
- **Transaction signing:** Takes 5-15 seconds for MPC nodes to coordinate
- **Transaction submission:** Takes 10-60 seconds to be included in a block
- **Finalization:** Takes additional time depending on network finality (usually 1-2 blocks)

All times are approximate and depend on network conditions and MPC node performance.
