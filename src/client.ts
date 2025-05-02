import { NatsConnection, JSONCodec, Subscription } from "nats";
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
const TOPICS = {
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
    nc.publish(TOPICS.GENERATE_KEY, jc.encode(msg));
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
    nc.publish(TOPICS.SIGN_TX, jc.encode(msg));
    console.log(`SignTransaction request sent for txID: ${txId}`);

    return txId;
  }

  // Update the callback handler methods to match the new field names
  onWalletCreationResult(callback: (event: KeygenSuccessEvent) => void): void {
    const { nc } = this.options;

    const sub = nc.subscribe(TOPICS.KEYGEN_SUCCESS);
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
    
    // Create a JetStream manager
    const js = nc.jetstream();
    
    // Create a JetStream consumer
    const consumerName = `sign-result-consumer-${uuidv4().substring(0, 8)}`;
    
    // First, ensure the stream exists
    (async () => {
      try {
        // Create or get the stream
        await js.streams.info("MPC_SIGNING_RESULTS").catch(async () => {
          // Stream doesn't exist, create it
          await js.streams.add({
            name: "MPC_SIGNING_RESULTS",
            subjects: ["mpc.signing_result.*"],
            retention: "interest",
            max_age: 60 * 60 * 1000 * 1000 * 1000, // 1 hour in nanoseconds
          });
        });
        
        // Create a consumer for the stream
        await js.consumers.add("MPC_SIGNING_RESULTS", {
          durable_name: consumerName,
          ack_policy: "explicit",
          deliver_subject: `${consumerName}.delivery`,
          deliver_group: "mpcium-clients",
          filter_subject: TOPICS.SIGNING_RESULT,
        });
        
        // Subscribe to the consumer's delivery subject
        const sub = nc.subscribe(`${consumerName}.delivery`);
        
        (async () => {
          for await (const msg of sub) {
            try {
              const jsmsg = js.messages.get(msg);
              console.log("Received signing result:", msg.headers);
              
              const event = jc.decode(msg.data) as SigningResultEvent;
              
              // Convert base64 signature to Buffer if needed
              if (typeof event.signature === "string") {
                event.signature = Buffer.from(event.signature, "base64");
              }
              
              try {
                callback(event);
                // Acknowledge successful processing
                await jsmsg.ack();
                console.log("Successfully processed and acknowledged message");
              } catch (callbackError) {
                console.error("Error in callback handler:", callbackError);
                // Negative acknowledgment - will be redelivered
                await jsmsg.nak();
              }
            } catch (error) {
              console.error("Error processing signing result:", error);
              // If we can't decode the message, terminate it
              try {
                const jsmsg = js.messages.get(msg);
                await jsmsg.term();
                console.log("Terminated message due to processing error");
              } catch (e) {
                console.error("Failed to terminate message:", e);
              }
            }
          }
        })().catch(err => {
          console.error("Error in subscription processing:", err);
        });
        
        this.subscriptions.push(sub);
        console.log("Subscribed to signing results with JetStream");
        
      } catch (err) {
        console.error("Error setting up JetStream consumer:", err);
      }
    })();
  }
}
