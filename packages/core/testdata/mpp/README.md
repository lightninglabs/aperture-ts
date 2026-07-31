# Machine Payments Protocol interop harness

The wire encodings in `packages/core/src/mpp` exist to agree with somebody
else, so they are checked against somebody else. The reference
implementation is the Go `mpp` package in
[aperture](https://github.com/lightninglabs/aperture), and this directory
holds the tooling that checks both directions of that agreement.

## Go to TypeScript: `vectors.json`

`gen_vectors.go` runs against the Go package and prints canonicalization,
base64url, challenge-id, header, credential, and receipt vectors. The
TypeScript tests in `src/mpp/*.test.ts` assert against every one of them.

The generator lives here as a build-ignored file rather than as a module,
because the aperture `mpp` package is not yet published. Run it from a
scratch module:

```sh
mkdir /tmp/mppvec && cd /tmp/mppvec
go mod init mppvec
go mod edit -require=github.com/lightninglabs/aperture@v0.0.0
go mod edit -replace=github.com/lightninglabs/aperture=/path/to/aperture
cp /path/to/aperture-ts/packages/core/testdata/mpp/gen_vectors.go .
go mod tidy
go run gen_vectors.go > vectors.json
```

Then copy `vectors.json` back over the one here and run
`pnpm --filter @aperture/core test`.

## TypeScript to Go: the transcript

Vectors prove that TypeScript reproduces Go's bytes. They cannot prove that
Go accepts TypeScript's, which is the direction a buyer actually depends on.
`emit_transcript.mjs` produces a buyer transcript, and
`verify_transcript.go` replays it as the seller: it parses each
`WWW-Authenticate` header, verifies the challenge id binds to the parsed
parameters, parses the `Authorization` credential, and recomputes the HMAC
from the echoed challenge, which is exactly what an aperture handler does.

```sh
pnpm -r build
cd packages/core/testdata/mpp && node emit_transcript.mjs > /tmp/transcript.json

# From the same scratch module as above, with verify_transcript.go copied in.
go run verify_transcript.go /tmp/transcript.json
```

## Known limitations of the reference implementation

Three of these turned up while building the harness. All three are pinned by
tests on the TypeScript side, so a change on either end is caught here rather
than by a failing HMAC against a live server.

1. **Canonicalization is not RFC 8785 in two places.** Object keys sort by
   Unicode code point rather than UTF-16 code unit, which differs only for
   astral characters, and strings escape `<`, `>`, `&`, U+2028, and U+2029
   because Go's `encoding/json` escapes them by default. The TypeScript
   implementation follows the reference on both, since interoperating with
   the implementation on the other end of the wire beats matching the RFC in
   isolation.

2. **The Go challenge-header parser cannot read back its own output when a
   parameter value contains `"` or `\`.** `SetChallengeHeader` writes the
   value with `%q`, which escapes both, and `parseAuthParams` stops at the
   first `"` without honoring the escape. A value containing a comma is
   handled correctly. This does not affect verification, because a server
   recomputes its HMAC from the JSON-decoded credential rather than from a
   re-parse of its own header, but it does mean a Go client cannot round-trip
   such a challenge. The TypeScript parser resolves the escapes, so it can.

3. **`ParseChallengeHeader` reads one challenge per call.** A 402 offering
   both a charge and a session intent writes two `WWW-Authenticate` lines,
   which the Fetch API hands a browser-style client back as a single
   comma-joined string. `parsePaymentChallenges` on the TypeScript side
   recovers the individual challenges from that form.
