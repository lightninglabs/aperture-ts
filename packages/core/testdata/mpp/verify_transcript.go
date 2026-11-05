//go:build ignore

// verify_transcript plays the Go reference implementation as the seller
// against a transcript emitted by emit_transcript.mjs, checking that every
// header the TypeScript buyer produced parses and that every HMAC binding
// still verifies after the round trip through the credential echo.
//
// This is the direction the generated vectors cannot cover: vectors.json
// proves the TypeScript side reproduces Go's output, and this proves the Go
// side accepts TypeScript's. See README.md for how to run it.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"

	"github.com/lightninglabs/aperture/mpp"
)

type exchange struct {
	Name            string         `json:"name"`
	Secret          string         `json:"secret"`
	WWWAuthenticate string         `json:"wwwAuthenticate"`
	Authorization   string         `json:"authorization"`
	ExpectPayload   map[string]any `json:"expectPayload"`
}

type canonical struct {
	Input     string `json:"input"`
	Canonical string `json:"canonical"`
}

type transcript struct {
	Transcript []exchange  `json:"transcript"`
	Canonical  []canonical `json:"canonical"`
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}

	var t transcript
	if err := json.Unmarshal(raw, &t); err != nil {
		panic(err)
	}

	failures := 0
	for _, ex := range t.Transcript {
		if err := check(ex); err != nil {
			fmt.Printf("FAIL %-18s %v\n", ex.Name, err)
			failures++
			continue
		}
		fmt.Printf("ok   %-18s\n", ex.Name)
	}

	for i, c := range t.Canonical {
		got, err := mpp.CanonicalizeJSON([]byte(c.Input))
		if err != nil {
			fmt.Printf("FAIL canonical[%d] %v\n", i, err)
			failures++
			continue
		}
		if string(got) != c.Canonical {
			fmt.Printf("FAIL canonical[%d]\n  go: %s\n  ts: %s\n",
				i, got, c.Canonical)
			failures++
			continue
		}
		fmt.Printf("ok   canonical[%d]      %s\n", i, c.Canonical)
	}

	if failures > 0 {
		fmt.Printf("\n%d failure(s)\n", failures)
		os.Exit(1)
	}
	fmt.Printf("\nall %d exchanges verified\n",
		len(t.Transcript)+len(t.Canonical))
}

// check runs the seller's half of one exchange: parse the challenge header
// the TypeScript side formatted, parse the credential it answered with, and
// verify that the echoed challenge still binds to the same id.
func check(ex exchange) error {
	// Parse the challenge header as a client would, to confirm the
	// TypeScript formatter emits something this package can read back.
	params, err := mpp.ParseChallengeHeader(ex.WWWAuthenticate)
	if err != nil {
		return fmt.Errorf("parse challenge header: %w", err)
	}

	// Verify the id the TypeScript side computed is the id this package
	// would have computed for the same parameters.
	if !mpp.VerifyChallengeID([]byte(ex.Secret), params, params.ID) {
		return fmt.Errorf("challenge id %q does not verify against the "+
			"parsed parameters", params.ID)
	}

	// Parse the credential exactly as an aperture handler would.
	h := make(http.Header)
	h.Set("Authorization", ex.Authorization)

	cred, err := mpp.ParseCredential(&h)
	if err != nil {
		return fmt.Errorf("parse credential: %w", err)
	}

	// Recompute the binding from the echoed challenge. This is the check
	// that fails when a client rewrites any challenge parameter on its way
	// back, which is the whole reason the echo exists.
	echoed := cred.Challenge.ToChallengeParams()
	if !mpp.VerifyChallengeID([]byte(ex.Secret), echoed, cred.Challenge.ID) {
		return fmt.Errorf("echoed challenge does not verify: %+v", echoed)
	}

	// The echo must be the header, field for field.
	if !reflect.DeepEqual(*echoed, *params) {
		return fmt.Errorf("echo differs from header:\n  header: %+v\n"+
			"  echo:   %+v", *params, *echoed)
	}

	// The payload must decode to what the buyer said it sent.
	var payload map[string]any
	if err := json.Unmarshal(cred.Payload, &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}
	if !reflect.DeepEqual(payload, ex.ExpectPayload) {
		return fmt.Errorf("payload mismatch:\n  got:  %+v\n  want: %+v",
			payload, ex.ExpectPayload)
	}

	// The credential must not carry a payer identifier: this client leaves
	// the DID field unset on purpose.
	if cred.Source != "" {
		return fmt.Errorf("credential carries a source: %q", cred.Source)
	}

	// Round-trip the intent-specific request object through this package's
	// decoder, to confirm the TypeScript encoder produced something it can
	// read.
	switch params.Intent {
	case mpp.IntentCharge:
		var req mpp.ChargeRequest
		if err := mpp.DecodeRequest(params.Request, &req); err != nil {
			return fmt.Errorf("decode charge request: %w", err)
		}
		if req.MethodDetails.Invoice == "" {
			return fmt.Errorf("charge request has no invoice")
		}

	case mpp.IntentSession:
		var req mpp.SessionRequest
		if err := mpp.DecodeRequest(params.Request, &req); err != nil {
			return fmt.Errorf("decode session request: %w", err)
		}
		if req.PaymentHash == "" {
			return fmt.Errorf("session request has no payment hash")
		}
	}

	return nil
}
