//go:build ignore

// gen_vectors generates JSON test vectors for cross-compatibility testing
// between the Go WASM bridge and the TypeScript runtime.
//
// Run: go run testdata/gen_vectors.go > testdata/vectors.json
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/lightninglabs/aperture-ts/packages/wasm/internal/l402"
)

type TestVector struct {
	Name        string `json:"name"`
	RootKeyHex  string `json:"rootKeyHex"`
	PreimageHex string `json:"preimageHex"`
	PaymentHash string `json:"paymentHash"`
	TokenIdHex  string `json:"tokenIdHex"`
	Caveats     []struct {
		Condition string `json:"condition"`
		Value     string `json:"value"`
	} `json:"caveats"`
	IdentifierHex string `json:"identifierHex,omitempty"`
}

func main() {
	vectors := make([]TestVector, 0)

	// Vector 1: Basic preimage → payment hash.
	preimage := make([]byte, 32)
	rand.Read(preimage)
	hash := sha256.Sum256(preimage)

	vectors = append(vectors, TestVector{
		Name:        "preimage_to_hash",
		PreimageHex: hex.EncodeToString(preimage),
		PaymentHash: hex.EncodeToString(hash[:]),
	})

	// Vector 2: Identifier encoding.
	var paymentHash, tokenID [32]byte
	rand.Read(paymentHash[:])
	rand.Read(tokenID[:])

	// Encode using the same logic as bridge.go.
	encoded := encodeID(paymentHash, tokenID)

	vectors = append(vectors, TestVector{
		Name:          "identifier_roundtrip",
		PaymentHash:   hex.EncodeToString(paymentHash[:]),
		TokenIdHex:    hex.EncodeToString(tokenID[:]),
		IdentifierHex: hex.EncodeToString(encoded),
	})

	// Vector 3: Service caveat encoding.
	svc, _ := l402.NewServicesCaveat(l402.Service{
		Name: "test_api", Tier: l402.BaseTier, Price: 10,
	})

	vectors = append(vectors, TestVector{
		Name: "service_caveat",
		Caveats: []struct {
			Condition string `json:"condition"`
			Value     string `json:"value"`
		}{
			{Condition: svc.Condition, Value: svc.Value},
		},
	})

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(vectors); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func encodeID(paymentHash, tokenID [32]byte) []byte {
	// version(2) + hash(32) + id(32) = 66 bytes
	buf := make([]byte, 66)
	buf[0] = 0
	buf[1] = 0
	copy(buf[2:34], paymentHash[:])
	copy(buf[34:66], tokenID[:])
	return buf
}
