/**
 * Minimal, dependency-free extraction of the payment amount from a BOLT11
 * invoice string. Only the human-readable part is inspected; the invoice is
 * not otherwise decoded or validated. This is enough for budget policy,
 * which needs the quoted amount before deciding whether to pay.
 */

/**
 * Known human-readable-part prefixes, ordered longest first so that
 * "lnbcrt" (regtest) is not mistaken for "lnbc" (mainnet) followed by
 * amount digits. "lntbs" (signet) is listed before "lntb" (testnet) for
 * the same reason.
 */
const HRP_PREFIXES = ["lnbcrt", "lntbs", "lntb", "lnsb", "lnbc"];

/** Pico-BTC per satoshi (1 BTC = 1e8 sat = 1e12 pico-BTC). */
const PICO_PER_SAT = 10_000n;

/**
 * Pico-BTC per unit for a BOLT11 amount multiplier character; a missing
 * multiplier means the amount is denominated in whole BTC.
 */
function picoPerUnit(multiplier: string | undefined): bigint {
  switch (multiplier) {
    case "m":
      return 1_000_000_000n; // milli-BTC (1e-3 BTC).
    case "u":
      return 1_000_000n; // micro-BTC (1e-6 BTC).
    case "n":
      return 1_000n; // nano-BTC (1e-9 BTC).
    case "p":
      return 1n; // pico-BTC (1e-12 BTC).
    default:
      return 1_000_000_000_000n; // Whole BTC (no multiplier).
  }
}

/**
 * Decode the amount, in satoshis, encoded in a BOLT11 invoice's
 * human-readable part (`ln<currency-prefix><amount><multiplier>`).
 *
 * Returns 0 only for a genuine zero-amount invoice: a known prefix with no
 * amount digits between it and the bech32 separator. Returns null when the
 * amount cannot be decoded at all — the string is not a BOLT11 invoice, the
 * currency prefix is unknown, or the amount slot is malformed. The caller
 * must treat a null the same as an unbounded outflow and refuse to pay,
 * rather than passing a fabricated 0 to the budget policy.
 *
 * The decoder is intentionally non-validating on details the wallet's real
 * BOLT11 decoder rejects downstream, such as mixed-case strings and
 * leading-zero amounts. It only extracts enough of the human-readable part
 * to bound the outflow for budget policy.
 *
 * Sub-satoshi amounts, which the pico multiplier can express, are rounded
 * up: the payer settles in millisatoshis, but budget policy should assert
 * on the ceiling of the outflow.
 */
export function bolt11AmountSat(invoice: string): number | null {
  const lower = invoice.trim().toLowerCase();

  // The bech32 separator is the last "1" in the string: the data charset
  // contains no "1", so everything before it is the human-readable part.
  // This also disambiguates a zero-amount invoice such as "lnbc1..."
  // (separator right after the prefix) from a 1 BTC invoice such as
  // "lnbc11..." (amount digit followed by the separator).
  const separator = lower.lastIndexOf("1");
  if (separator === -1) return null;
  const hrp = lower.slice(0, separator);

  const prefix = HRP_PREFIXES.find((p) => hrp.startsWith(p));
  if (!prefix) return null;

  // The amount is the digit run between the prefix and an optional
  // trailing multiplier character; an empty remainder means a genuine
  // zero-amount invoice.
  const rest = hrp.slice(prefix.length);
  if (rest === "") return 0;
  const match = rest.match(/^(\d+)([munp])?$/);
  if (!match?.[1]) return null;

  const units = BigInt(match[1]);
  const pico = units * picoPerUnit(match[2]);

  // Ceiling division to satoshis, so sub-satoshi amounts round up.
  const whole = pico / PICO_PER_SAT;
  return Number(pico % PICO_PER_SAT === 0n ? whole : whole + 1n);
}
