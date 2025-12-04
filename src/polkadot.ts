import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { encodeAddress, blake2AsU8a } from "@polkadot/util-crypto";
import type { SignerPayloadRaw, IExtrinsic } from "@polkadot/types/types";
import type { GenericSignerPayload } from "@polkadot/types";

export interface PolkadotNetwork {
  name: string;
  rpcUrl: string;
  ss58Prefix: number;
  networkCode: string;
}

export const POLKADOT_NETWORKS: Record<string, PolkadotNetwork> = {
  polkadot: {
    name: "Polkadot",
    rpcUrl: "wss://rpc.polkadot.io",
    ss58Prefix: 0,
    networkCode: "polkadot:mainnet",
  },
  kusama: {
    name: "Kusama",
    rpcUrl: "wss://kusama-rpc.polkadot.io",
    ss58Prefix: 2,
    networkCode: "kusama:mainnet",
  },
  westend: {
    name: "Westend",
    rpcUrl: "wss://westend-rpc.polkadot.io",
    ss58Prefix: 42,
    networkCode: "polkadot:westend",
  },
  rococo: {
    name: "Rococo",
    rpcUrl: "wss://rococo-rpc.polkadot.io",
    ss58Prefix: 42,
    networkCode: "polkadot:rococo",
  },
  // Asset Hub parachains
  "asset-hub-polkadot": {
    name: "Asset Hub (Polkadot)",
    rpcUrl: "wss://polkadot-asset-hub-rpc.polkadot.io",
    ss58Prefix: 0,
    networkCode: "polkadot:asset-hub",
  },
  "asset-hub-kusama": {
    name: "Asset Hub (Kusama)",
    rpcUrl: "wss://kusama-asset-hub-rpc.polkadot.io",
    ss58Prefix: 2,
    networkCode: "kusama:asset-hub",
  },
  "asset-hub-westend": {
    name: "Asset Hub (Westend)",
    rpcUrl: "wss://westend-asset-hub-rpc.polkadot.io",
    ss58Prefix: 42,
    networkCode: "polkadot:asset-hub-westend",
  },
};

export interface SigningPayloadResult {
  payloadHex: string;
  payloadBytes: Uint8Array;
  extrinsic: unknown;
  api: ApiPromise;
}

export interface BuildPayloadParams {
  mpcAddress: string;
  callPallet: string;
  callMethod: string;
  callArgs: unknown[];
  network: string | PolkadotNetwork;
  era?: number;
  tip?: bigint;
}

export interface AssetTransferParams {
  mpcAddress: string;
  assetId: number;
  destinationAddress: string;
  amount: bigint;
  network: string | PolkadotNetwork;
  tip?: bigint;
}

export interface NativeTransferParams {
  mpcAddress: string;
  destinationAddress: string;
  amount: bigint;
  network: string | PolkadotNetwork;
  keepAlive?: boolean;
  tip?: bigint;
}

export interface SubmitExtrinsicParams {
  api: ApiPromise;
  extrinsic: unknown;
  signatureHex: string;
  mpcAddress: string;
}

export interface SubmitExtrinsicResult {
  txHash: string;
  status: string;
  blockHash?: string;
}

export function ed25519PubKeyToSubstrateAddress(
  pubKeyBase64: string,
  ss58Prefix: number = 42
): string {
  const pubKeyBytes = Buffer.from(pubKeyBase64, "base64");
  if (pubKeyBytes.length !== 32) {
    throw new Error(
      `Invalid Ed25519 public key length: ${pubKeyBytes.length}, expected 32`
    );
  }
  return encodeAddress(pubKeyBytes, ss58Prefix);
}

async function getApi(network: string | PolkadotNetwork): Promise<ApiPromise> {
  const networkConfig =
    typeof network === "string" ? POLKADOT_NETWORKS[network] : network;
  if (!networkConfig) {
    throw new Error(`Unknown network: ${network}`);
  }
  const provider = new WsProvider(networkConfig.rpcUrl);
  return ApiPromise.create({ provider });
}

export async function buildSigningPayload(
  params: BuildPayloadParams
): Promise<SigningPayloadResult> {
  const networkConfig =
    typeof params.network === "string"
      ? POLKADOT_NETWORKS[params.network]
      : params.network;
  if (!networkConfig) {
    throw new Error(`Unknown network: ${params.network}`);
  }

  const api = await getApi(networkConfig);

  const pallet = api.tx[params.callPallet];
  if (!pallet) {
    throw new Error(`Unknown pallet: ${params.callPallet}`);
  }
  const method = pallet[params.callMethod];
  if (!method) {
    throw new Error(
      `Unknown method: ${params.callPallet}.${params.callMethod}`
    );
  }

  const call = method(...params.callArgs);
  const nonce = await api.rpc.system.accountNextIndex(params.mpcAddress);
  const blockHash = await api.rpc.chain.getBlockHash();
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const genesisHash = api.genesisHash;
  const runtimeVersion = api.runtimeVersion;

  const era = api.registry.createType("ExtrinsicEra", {
    current: blockNumber,
    period: params.era ?? 64,
  });

  const signerPayload = api.registry.createType("SignerPayload", {
    method: call,
    nonce,
    genesisHash,
    blockHash,
    blockNumber,
    era,
    runtimeVersion,
    tip: params.tip ?? 0,
    specVersion: runtimeVersion.specVersion,
    transactionVersion: runtimeVersion.transactionVersion,
    signedExtensions: api.registry.signedExtensions,
    version: 4,
  });

  const payloadRaw: SignerPayloadRaw = signerPayload.toRaw();
  let payloadBytes = hexToU8a(payloadRaw.data);

  // Substrate requires hashing payloads > 256 bytes
  if (payloadBytes.length > 256) {
    payloadBytes = blake2AsU8a(payloadBytes, 256);
  }

  const extrinsic = api.registry.createType(
    "Extrinsic",
    { method: call },
    { version: 4 }
  );

  return {
    payloadHex: u8aToHex(payloadBytes),
    payloadBytes,
    extrinsic: {
      unsigned: extrinsic,
      signerPayload,
      nonce: Number(nonce.toString()),
      era,
      tip: params.tip ?? BigInt(0),
    },
    api,
  };
}

export async function buildNativeTransferPayload(
  params: NativeTransferParams
): Promise<SigningPayloadResult> {
  const method = params.keepAlive ? "transferKeepAlive" : "transferAllowDeath";
  return buildSigningPayload({
    mpcAddress: params.mpcAddress,
    callPallet: "balances",
    callMethod: method,
    callArgs: [params.destinationAddress, params.amount],
    network: params.network,
    tip: params.tip,
  });
}

export async function buildAssetTransferPayload(
  params: AssetTransferParams
): Promise<SigningPayloadResult> {
  return buildSigningPayload({
    mpcAddress: params.mpcAddress,
    callPallet: "assets",
    callMethod: "transfer",
    callArgs: [params.assetId, params.destinationAddress, params.amount],
    network: params.network,
    tip: params.tip,
  });
}

export async function submitSignedExtrinsic(
  params: SubmitExtrinsicParams
): Promise<SubmitExtrinsicResult> {
  const { api, extrinsic: extrinsicData, signatureHex, mpcAddress } = params;

  const { unsigned, signerPayload, nonce, era, tip } = extrinsicData as {
    unsigned: IExtrinsic;
    signerPayload: GenericSignerPayload;
    nonce: number;
    era: ReturnType<typeof api.registry.createType>;
    tip: bigint;
  };

  const signatureBytes = hexToU8a(signatureHex);
  // Create MultiSignature with Ed25519 variant (0x00 prefix)
  const multiSignature = new Uint8Array(1 + signatureBytes.length);
  multiSignature[0] = 0x00; // Ed25519 variant
  multiSignature.set(signatureBytes, 1);

  // Add signature to the extrinsic
  const payload = signerPayload.toPayload();
  unsigned.addSignature(mpcAddress, u8aToHex(multiSignature), payload);

  return new Promise((resolve, reject) => {
    api.rpc.author
      .submitAndWatchExtrinsic(unsigned, (result) => {
        if (result.isInBlock) {
          resolve({
            txHash: unsigned.hash.toHex(),
            status: "inBlock",
            blockHash: result.asInBlock.toHex(),
          });
        } else if (result.isFinalized) {
          resolve({
            txHash: unsigned.hash.toHex(),
            status: "finalized",
            blockHash: result.asFinalized.toHex(),
          });
        }
      })
      .catch(reject);
  });
}

export function getNetworkCode(network: string | PolkadotNetwork): string {
  if (typeof network === "string") {
    const config = POLKADOT_NETWORKS[network];
    if (!config) {
      throw new Error(`Unknown network: ${network}`);
    }
    return config.networkCode;
  }
  return network.networkCode;
}

