/**
 * Example buyer client using @lightninglabs/aperture-client payingFetch.
 *
 * Usage: npx tsx examples/buyer-client.ts
 *
 * Prerequisites: Start the REST worker example first:
 *   cd examples/worker-rest-paid-api && pnpm dev
 */

import { createPayingFetch, MockInvoicePayer } from "@lightninglabs/aperture-client";
import { BudgetCapPolicy, HostAllowlistPolicy, CompositeBuyerPolicy } from "@lightninglabs/aperture-core/policy";

const SELLER_URL = "http://localhost:8787/v1/search";

// Create a mock payer (in production, use a real Lightning payer).
const payer = new MockInvoicePayer();

// Configure buyer policies.
const buyerPolicy = new CompositeBuyerPolicy([
  new BudgetCapPolicy(100), // Max 100 sat per request.
  new HostAllowlistPolicy(["localhost"]),
]);

// Create the paying fetch.
const payingFetch = createPayingFetch({
  payer,
  buyerPolicy,
});

async function main() {
  console.log("Making paid request to", SELLER_URL);

  try {
    const response = await payingFetch(SELLER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello world" }),
    });

    console.log("Status:", response.status);
    const body = await response.json();
    console.log("Response:", JSON.stringify(body, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
