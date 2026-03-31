/**
 * Cloudflare Worker environment bindings per design doc section 22.1.
 */

export interface Env {
  /** Master key for macaroon signing. Injected as Worker secret. */
  MACAROON_MASTER_KEY: string;

  /** Durable Object namespace for per-seller state. */
  SELLER_STATE: DurableObjectNamespace;

  /** Optional: service binding to an internal invoice Worker. */
  INVOICE_SERVICE?: Fetcher;

  /** Optional: service binding to an internal origin Worker. */
  ORIGIN_SERVICE?: Fetcher;

  /** Optional: KV namespace for seller config caching. */
  CONFIG_KV?: KVNamespace;

  /** Optional: Queue for async receipt export. */
  RECEIPT_QUEUE?: Queue;
}
