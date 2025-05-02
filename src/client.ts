import {
  NatsConnection,
  JSONCodec,
  Subscription,
  RetentionPolicy,
  AckPolicy,
  NatsError,
} from "nats";
import { v4 as uuidv4 } from "uuid";
import {
  GenerateKeyMessage,
  SignTxMessage,
  KeygenSuccessEvent,
  SigningResultEvent,
  KeyType,
} from "./types";
import {
  loadPrivateKey,
  signGenerateKeyMessage,
  signSignTxMessage,
  loadEncryptedPrivateKey,
} from "./utils";

const jc = JSONCodec();

// NATS topics
const SUBJECTS = {
  GENERATE_KEY: "mpc:generate",
  SIGN_TX: "mpc:sign",
  KEYGEN_SUCCESS: "mpc.mpc_keygen_success.*",
  SIGNING_RESULT: "mpc.signing_result.*",
};

export interface MpciumOptions {
  nc: NatsConnection;
  keyPath: string;
  password?: string; // Optional password for encrypted keys
  encrypted?: boolean; // Explicitly specify if key is encrypted
}

export class MpciumClient {
  private privateKey: Buffer;
  private subscriptions: Subscription[] = [];

  /**
   * Create a new MpciumClient instance
   */
  static async create(options: MpciumOptions): Promise<MpciumClient> {
    // Determine if key is encrypted based on file extension or explicit flag
    const isEncrypted = options.encrypted || options.keyPath.endsWith(".age");

    let privateKey: Buffer;

    if (isEncrypted) {
      if (!options.password) {
        throw new Error("Encrypted key detected but no password provided");
      }

      // Load encrypted key
      privateKey = await loadEncryptedPrivateKey(
        options.keyPath,
        options.password
      );
    } else {
      // Regular unencrypted key
      privateKey = loadPrivateKey(options.keyPath);
    }

    return new MpciumClient(options, privateKey);
  }

  /**
   * Private constructor - use static create() method instead
   */
  private constructor(private options: MpciumOptions, privateKey: Buffer) {
    this.privateKey = privateKey;

    // Set up status monitoring for the NATS connection
    this.monitorConnectionStatus();
  }

  /**
   * Monitor NATS connection status
   */
  private monitorConnectionStatus(): void {
    const { nc } = this.options;

    // Start an async task to process status updates
    (async () => {
      for await (const status of nc.status()) {
        switch (status.type) {
          case "error":
            console.error("NATS connection error:", status.data);
            break;
          case "disconnect":
            console.warn("NATS connection disconnected");
            break;
          case "reconnect":
            console.log("NATS connection reconnected");
            break;
          case "ldm":
            console.warn("NATS in limited downmode");
            break;
          default:
            console.log(`NATS connection status: ${status.type}`);
        }
      }
    })().catch((err) => {
      console.error("Error monitoring NATS connection status:", err);
    });
  }

  /**
   * Cleanly unsubscribe from all NATS subscriptions
   */
  async cleanup(): Promise<void> {
    // Unsubscribe from all subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    console.log("Cleaned up all subscriptions");
  }

  /**
   * Create a new MPC wallet
   * @param walletId Optional wallet ID (generates UUID if not provided)
   * @returns The wallet ID
   */
  async createWallet(walletId?: string): Promise<string> {
    const { nc } = this.options;

    // Generate a wallet ID if not provided
    const id = walletId || uuidv4();

    // Create the message
    const msg: GenerateKeyMessage = {
      wallet_id: id,
    };

    // Sign the message and convert Buffer to base64 string
    const signatureBuffer = await signGenerateKeyMessage(msg, this.privateKey);
    msg.signature = signatureBuffer.toString("base64");

    // Send the request
    nc.publish(SUBJECTS.GENERATE_KEY, jc.encode(msg));
    console.log(`CreateWallet request sent for wallet: ${id}`);

    return id;
  }

  /**
   * Sign a transaction using MPC
   * @param params Transaction parameters
   * @returns Transaction ID
   */
  async signTransaction(params: {
    walletId: string;
    keyType: KeyType;
    networkInternalCode: string;
    tx: string;
  }): Promise<string> {
    const { nc } = this.options;

    const txId = uuidv4();

    // Create the message
    const msg: SignTxMessage = {
      key_type: params.keyType,
      wallet_id: params.walletId,
      network_internal_code: params.networkInternalCode,
      tx_id: txId,
      tx: params.tx,
    };

    // Sign the message and convert Buffer to base64 string
    const signatureBuffer = await signSignTxMessage(msg, this.privateKey);
    msg.signature = signatureBuffer.toString("base64");

    // Send the request
    nc.publish(SUBJECTS.SIGN_TX, jc.encode(msg));
    console.log(`SignTransaction request sent for txID: ${txId}`);

    return txId;
  }

  // Update the callback handler methods to match the new field names
  onWalletCreationResult(callback: (event: KeygenSuccessEvent) => void): void {
    const { nc } = this.options;

    const sub = nc.subscribe(SUBJECTS.KEYGEN_SUCCESS);
    (async () => {
      for await (const msg of sub) {
        try {
          const event = jc.decode(msg.data) as KeygenSuccessEvent;
          callback(event);
        } catch (error) {
          console.error("Error processing wallet creation result:", error);
        }
      }
    })();

    this.subscriptions.push(sub);
    console.log("Subscribed to wallet creation results");
  }

  onSignResult(callback: (event: SigningResultEvent) => void): void {
    const { nc } = this.options;
    const consumerName = `signing_result`;

    (async () => {
      const js = nc.jetstream(); // for pub/sub
      const jsm = await nc.jetstreamManager(); // for admin

      // 1) Ensure the MAIN stream exists (by name)
      try {
        await jsm.streams.info("mpc");
      } catch {
        // 2) Try to add it—but ignore the "subject-overlap" error
        try {
          await jsm.streams.add({
            name: "mpc",
            subjects: [SUBJECTS.SIGNING_RESULT],
            retention: RetentionPolicy.Workqueue,
            max_bytes: 100 * 1024 * 1024,
          });
        } catch (err) {
          console.error("Error creating stream adding:", err);
          // NatsError.err_code 10065 → "subjects overlap with an existing stream"
          if (err instanceof NatsError && err.api_error?.err_code === 10065) {
            console.warn(
              "Stream subjects overlap; proceeding without re-creating stream"
            );
          } else {
            throw err; // re-throw anything else
          }
        }
      }

      try {
        await jsm.consumers.info("mpc", consumerName);
        // already there—skip jsm.consumers.add()
      } catch {
        // 2) Create durable consumer
        await jsm.consumers.add("mpc", {
          durable_name: consumerName,
          ack_policy: AckPolicy.Explicit,
          filter_subject: SUBJECTS.SIGNING_RESULT,
          max_deliver: 3,
        });
      }

      // 4) now fetch that consumer and **consume()**
      const consumer = await js.consumers.get("mpc", consumerName);
      console.log("Subscribed to signing results (consume mode)");

      const sub = await consumer.consume(); // ← await here
      for await (const m of sub) {
        try {
          const event = jc.decode(m.data) as SigningResultEvent;
          callback(event);
          m.ack();
        } catch (err) {
          console.error("Error processing message:", err);
          m.term();
        }
      }
    })().catch((err) => {
      console.error("Error setting up JetStream consumer:", err);
    });
  }
}
