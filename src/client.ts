import {
  JSONCodec,
  Subscription,
  RetentionPolicy,
  AckPolicy,
  NatsError,
  ConsumerMessages,
} from "nats";
import { v4 as uuidv4 } from "uuid";
import {
  GenerateKeyMessage,
  SignTxMessage,
  ResharingMessage,
  KeygenSuccessEvent,
  SigningResultEvent,
  ResharingResultEvent,
  KeyType,
} from "./types";
import {
  loadPrivateKey,
  signGenerateKeyMessage,
  signSignTxMessage,
  signResharingMessage,
  loadEncryptedPrivateKey,
} from "./utils";
import { MpciumOptions } from "./types";

const jc = JSONCodec();

// NATS topics
const SUBJECTS = {
  KEYGEN_RESULT: "mpc.mpc_keygen_result.*",
  SIGNING_RESULT: "mpc.mpc_signing_result.*",
  RESHARE_RESULT: "mpc.mpc_reshare_result.*",
  RESHARE_REQUEST: "mpc:reshare",
};

export class MpciumClient {
  private privateKey: Buffer;
  private subscriptions: (Subscription | ConsumerMessages)[] = [];

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
      if ("unsubscribe" in sub) {
        sub.unsubscribe();
      } else {
        // Handle ConsumerMessages
        sub.stop();
      }
    }
    this.subscriptions = [];
    console.log("Cleaned up all subscriptions");
  }

  /**
   * Check if JetStream is available
   */
  private async checkJetStreamAvailability(): Promise<boolean> {
    const { nc } = this.options;
    try {
      const jsm = await nc.jetstreamManager();
      await jsm.getAccountInfo();
      return true;
    } catch (err) {
      console.error("JetStream is not available:", err);
      return false;
    }
  }

  /**
   * Ensure JetStream streams exist for publishing
   */
  private async ensureStreamsExist(): Promise<void> {
    const { nc } = this.options;

    // Check if JetStream is available first
    const jsAvailable = await this.checkJetStreamAvailability();
    if (!jsAvailable) {
      throw new Error(
        "JetStream is not available. Please enable JetStream on your NATS server."
      );
    }

    const jsm = await nc.jetstreamManager();

    // Ensure keygen stream exists
    try {
      await jsm.streams.info("mpc-keygen");
    } catch {
      try {
        await jsm.streams.add({
          name: "mpc-keygen",
          subjects: ["mpc.keygen_request.*"],
          retention: RetentionPolicy.Workqueue,
          max_bytes: 100 * 1024 * 1024,
        });
        console.log("Created mpc-keygen stream");
      } catch (err) {
        if (err instanceof NatsError && err.api_error?.err_code === 10065) {
          console.warn("mpc-keygen stream subjects overlap; proceeding");
        } else {
          throw err;
        }
      }
    }

    // Ensure signing stream exists
    try {
      await jsm.streams.info("mpc-signing");
    } catch {
      try {
        await jsm.streams.add({
          name: "mpc-signing",
          subjects: ["mpc.signing_request.*"],
          retention: RetentionPolicy.Workqueue,
          max_bytes: 100 * 1024 * 1024,
        });
        console.log("Created mpc-signing stream");
      } catch (err) {
        if (err instanceof NatsError && err.api_error?.err_code === 10065) {
          console.warn("mpc-signing stream subjects overlap; proceeding");
        } else {
          throw err;
        }
      }
    }
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

    try {
      // Try JetStream first
      await this.ensureStreamsExist();
      const js = nc.jetstream();
      await js.publish("mpc.keygen_request", jc.encode(msg));
      console.log(`CreateWallet request sent via JetStream for wallet: ${id}`);
    } catch (err) {
      // Fall back to core NATS if JetStream is not available
      console.warn("JetStream not available, falling back to core NATS");
      nc.publish("mpc.keygen_request", jc.encode(msg));
      console.log(`CreateWallet request sent via core NATS for wallet: ${id}`);
    }

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

    try {
      // Try JetStream first
      await this.ensureStreamsExist();
      const js = nc.jetstream();
      await js.publish(`mpc.signing_request.${txId}`, jc.encode(msg));
      console.log(
        `SignTransaction request sent via JetStream for txID: ${txId}`
      );
    } catch (err) {
      // Fall back to core NATS if JetStream is not available
      console.warn("JetStream not available, falling back to core NATS");
      nc.publish(`mpc.signing_request.${txId}`, jc.encode(msg));
      console.log(
        `SignTransaction request sent via core NATS for txID: ${txId}`
      );
    }

    return txId;
  }

  /**
   * Initiate resharing of MPC keys
   * @param params Resharing parameters
   * @returns Session ID
   */
  async reshareKeys(params: {
    sessionId?: string;
    walletId: string;
    nodeIds: string[];
    newThreshold: number;
    keyType: KeyType;
  }): Promise<string> {
    const { nc } = this.options;

    // Generate session ID if not provided
    const sessionId = params.sessionId || uuidv4();

    // Create the message
    const msg: ResharingMessage = {
      session_id: sessionId,
      wallet_id: params.walletId,
      node_ids: params.nodeIds,
      new_threshold: params.newThreshold,
      key_type: params.keyType,
    };

    console.log("msg", msg);

    // Sign the message and convert Buffer to base64 string
    const signatureBuffer = await signResharingMessage(msg, this.privateKey);
    msg.signature = signatureBuffer.toString("base64");

    // Use core NATS to publish (matching Go implementation)
    nc.publish(SUBJECTS.RESHARE_REQUEST, jc.encode(msg));
    console.log(`Resharing request sent for session: ${sessionId}`);

    return sessionId;
  }

  onWalletCreationResult(callback: (event: KeygenSuccessEvent) => void): void {
    const { nc } = this.options;
    const consumerName = `mpc_keygen_result`;

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
            subjects: [SUBJECTS.KEYGEN_RESULT],
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
          filter_subject: SUBJECTS.KEYGEN_RESULT,
          max_deliver: 3,
        });
      }

      // 4) now fetch that consumer and **consume()**
      const consumer = await js.consumers.get("mpc", consumerName);
      console.log("Subscribed to wallet creation results (consume mode)");

      const sub = await consumer.consume(); // ← await here
      this.subscriptions.push(sub);

      for await (const m of sub) {
        try {
          const event = jc.decode(m.data) as KeygenSuccessEvent;
          callback(event);
          m.ack();
        } catch (err) {
          console.error("Error processing wallet creation message:", err);
          m.term();
        }
      }
    })().catch((err) => {
      console.error(
        "Error setting up JetStream consumer for wallet creation:",
        err
      );
    });
  }

  onSignResult(callback: (event: SigningResultEvent) => void): void {
    const { nc } = this.options;
    const consumerName = `mpc_signing_result`;

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
      this.subscriptions.push(sub);

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

  /**
   * Listen for resharing results
   * @param callback Function to handle resharing results
   */
  onResharingResult(callback: (event: ResharingResultEvent) => void): void {
    const { nc } = this.options;
    const consumerName = `mpc_reshare_result`;

    (async () => {
      const js = nc.jetstream(); // for pub/sub
      const jsm = await nc.jetstreamManager(); // for admin

      try {
        await jsm.streams.info("mpc");
      } catch {
        try {
          await jsm.streams.add({
            name: "mpc",
            subjects: [SUBJECTS.RESHARE_RESULT],
            retention: RetentionPolicy.Workqueue,
            max_bytes: 100 * 1024 * 1024,
          });
        } catch (err) {
          console.error("Error creating stream adding:", err);
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
      } catch {
        await jsm.consumers.add("mpc", {
          durable_name: consumerName,
          ack_policy: AckPolicy.Explicit,
          filter_subject: SUBJECTS.RESHARE_RESULT,
          max_deliver: 3,
        });
      }

      const consumer = await js.consumers.get("mpc", consumerName);
      console.log("Subscribed to resharing results (consume mode)");

      const sub = await consumer.consume(); // ← await here
      this.subscriptions.push(sub);

      for await (const m of sub) {
        try {
          const event = jc.decode(m.data) as ResharingResultEvent;
          callback(event);
          m.ack();
        } catch (err) {
          console.error("Error processing resharing message:", err);
          m.term();
        }
      }
    })().catch((err) => {
      console.error(
        "Error setting up JetStream consumer for resharing results:",
        err
      );
    });
  }
}
