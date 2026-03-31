//go:build js && wasm

// Package main implements a Go→WASM bridge that exposes aperture's L402
// macaroon primitives to JavaScript. It wraps the core caveat, satisfier,
// and identifier logic from the aperture/l402 package while avoiding heavy
// transitive dependencies (lnrpc, grpc) by inlining the identifier codec
// (which only needs [32]byte types, not full lntypes).
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"syscall/js"
	"time"

	"github.com/lightninglabs/aperture-ts/packages/wasm/internal/l402"
	"gopkg.in/macaroon.v2"
)

// Identifier constants matching aperture/l402/identifier.go.
const (
	latestVersion = 0
	tokenIDSize   = 32
)

var byteOrder = binary.BigEndian

func main() {
	// Register all exported functions under the global apertureWasm
	// namespace.
	exports := js.Global().Get("Object").New()

	exports.Set("mintMacaroon", js.FuncOf(jsMintMacaroon))
	exports.Set("verifyMacaroon", js.FuncOf(jsVerifyMacaroon))
	exports.Set("verifyPreimage", js.FuncOf(jsVerifyPreimage))
	exports.Set("encodeIdentifier", js.FuncOf(jsEncodeIdentifier))
	exports.Set("decodeIdentifier", js.FuncOf(jsDecodeIdentifier))
	exports.Set("verifyCaveats", js.FuncOf(jsVerifyCaveats))
	exports.Set("addFirstPartyCaveats", js.FuncOf(jsAddFirstPartyCaveats))

	js.Global().Set("apertureWasm", exports)

	// Block forever so the WASM instance stays alive.
	select {}
}

// encodeIdentifierBytes encodes a version-0 L402 identifier: uint16 version ||
// [32]byte paymentHash || [32]byte tokenID.
func encodeIdentifierBytes(paymentHash, tokenID [32]byte) []byte {
	var buf bytes.Buffer
	_ = binary.Write(&buf, byteOrder, uint16(latestVersion))
	buf.Write(paymentHash[:])
	buf.Write(tokenID[:])
	return buf.Bytes()
}

// decodeIdentifierBytes decodes a version-0 L402 identifier.
func decodeIdentifierBytes(data []byte) (version uint16, paymentHash, tokenID [32]byte, err error) {
	r := bytes.NewReader(data)
	if err = binary.Read(r, byteOrder, &version); err != nil {
		return
	}
	if version != 0 {
		err = fmt.Errorf("unknown L402 version: %d", version)
		return
	}
	if _, err = r.Read(paymentHash[:]); err != nil {
		return
	}
	_, err = r.Read(tokenID[:])
	return
}

// jsMintMacaroon mints a new macaroon with the given root key, payment hash,
// and caveats.
//
// Args: rootKeyHex (string), paymentHashHex (string), caveatsJSON (Array of
// {condition, value}).
// Returns: {macaroonB64, tokenIdHex, identifierHex} or {error: string}.
func jsMintMacaroon(_ js.Value, args []js.Value) any {
	if len(args) < 3 {
		return jsError("mintMacaroon requires 3 args: rootKeyHex, paymentHashHex, caveatsJSON")
	}

	rootKeyHex := args[0].String()
	paymentHashHex := args[1].String()
	caveatsArr := args[2]

	rootKey, err := hex.DecodeString(rootKeyHex)
	if err != nil {
		return jsError(fmt.Sprintf("invalid rootKey hex: %v", err))
	}

	paymentHashBytes, err := hex.DecodeString(paymentHashHex)
	if err != nil || len(paymentHashBytes) != 32 {
		return jsError("invalid paymentHash hex: must be 64 hex chars")
	}

	var paymentHash [32]byte
	copy(paymentHash[:], paymentHashBytes)

	// Generate a random token ID.
	var tokenID [32]byte
	if _, err := rand.Read(tokenID[:]); err != nil {
		return jsError(fmt.Sprintf("failed to generate token ID: %v", err))
	}

	// Encode the identifier using local codec (avoids lntypes dependency).
	idBytes := encodeIdentifierBytes(paymentHash, tokenID)

	// Create the macaroon using gopkg.in/macaroon.v2.
	mac, err := macaroon.New(
		rootKey, idBytes, "lsat", macaroon.LatestVersion,
	)
	if err != nil {
		return jsError(fmt.Sprintf("failed to create macaroon: %v", err))
	}

	// Add caveats using aperture's l402 package.
	caveats := parseCaveatsFromJS(caveatsArr)
	if err := l402.AddFirstPartyCaveats(mac, caveats...); err != nil {
		return jsError(fmt.Sprintf("failed to add caveats: %v", err))
	}

	// Serialize to base64.
	macBytes, err := mac.MarshalBinary()
	if err != nil {
		return jsError(fmt.Sprintf("failed to marshal macaroon: %v", err))
	}

	result := js.Global().Get("Object").New()
	result.Set("macaroonB64", base64.StdEncoding.EncodeToString(macBytes))
	result.Set("tokenIdHex", hex.EncodeToString(tokenID[:]))
	result.Set("identifierHex", hex.EncodeToString(idBytes))

	return result
}

// jsVerifyMacaroon verifies a macaroon's HMAC-chain signature against the
// given root key and returns its decoded caveats.
//
// Args: rootKeyHex (string), macaroonB64 (string).
// Returns: {valid: bool, caveats: [{condition, value}], error?: string}.
func jsVerifyMacaroon(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("verifyMacaroon requires 2 args: rootKeyHex, macaroonB64")
	}

	rootKeyHex := args[0].String()
	macaroonB64 := args[1].String()

	rootKey, err := hex.DecodeString(rootKeyHex)
	if err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("invalid rootKey hex: %v", err))
	}

	macBytes, err := base64.StdEncoding.DecodeString(macaroonB64)
	if err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("invalid macaroon base64: %v", err))
	}

	var mac macaroon.Macaroon
	if err := mac.UnmarshalBinary(macBytes); err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("failed to unmarshal macaroon: %v", err))
	}

	// Verify the HMAC-chain signature.
	rawCaveats, err := mac.VerifySignature(rootKey, nil)
	if err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("signature verification failed: %v", err))
	}

	// Decode the caveats using aperture's format.
	var caveats []l402.Caveat
	for _, raw := range rawCaveats {
		caveat, decErr := l402.DecodeCaveat(raw)
		if decErr != nil {
			continue
		}
		caveats = append(caveats, caveat)
	}

	return jsVerifyResult(true, caveats, "")
}

// jsVerifyPreimage checks that sha256(preimage) == paymentHash.
//
// Args: preimageHex (string), paymentHashHex (string).
// Returns: bool.
func jsVerifyPreimage(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return false
	}

	preimageBytes, err := hex.DecodeString(args[0].String())
	if err != nil || len(preimageBytes) != 32 {
		return false
	}

	paymentHashBytes, err := hex.DecodeString(args[1].String())
	if err != nil || len(paymentHashBytes) != 32 {
		return false
	}

	computed := sha256.Sum256(preimageBytes)
	return bytes.Equal(computed[:], paymentHashBytes)
}

// jsEncodeIdentifier encodes a version-0 L402 identifier.
//
// Args: paymentHashHex (string), tokenIdHex (string).
// Returns: hex string of the encoded identifier.
func jsEncodeIdentifier(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("encodeIdentifier requires 2 args: paymentHashHex, tokenIdHex")
	}

	paymentHashBytes, err := hex.DecodeString(args[0].String())
	if err != nil || len(paymentHashBytes) != 32 {
		return jsError("invalid paymentHash hex")
	}

	tokenIDBytes, err := hex.DecodeString(args[1].String())
	if err != nil || len(tokenIDBytes) != tokenIDSize {
		return jsError("invalid tokenId hex")
	}

	var paymentHash, tokenID [32]byte
	copy(paymentHash[:], paymentHashBytes)
	copy(tokenID[:], tokenIDBytes)

	return hex.EncodeToString(encodeIdentifierBytes(paymentHash, tokenID))
}

// jsDecodeIdentifier decodes an L402 identifier from hex.
//
// Args: identifierHex (string).
// Returns: {version, paymentHashHex, tokenIdHex} or {error: string}.
func jsDecodeIdentifier(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("decodeIdentifier requires 1 arg: identifierHex")
	}

	idBytes, err := hex.DecodeString(args[0].String())
	if err != nil {
		return jsError(fmt.Sprintf("invalid identifier hex: %v", err))
	}

	version, paymentHash, tokenID, err := decodeIdentifierBytes(idBytes)
	if err != nil {
		return jsError(fmt.Sprintf("failed to decode identifier: %v", err))
	}

	result := js.Global().Get("Object").New()
	result.Set("version", int(version))
	result.Set("paymentHashHex", hex.EncodeToString(paymentHash[:]))
	result.Set("tokenIdHex", hex.EncodeToString(tokenID[:]))

	return result
}

// jsVerifyCaveats verifies a macaroon's caveats against built-in satisfiers
// (services + timeout).
//
// Args: macaroonB64 (string), rootKeyHex (string), targetService (string),
// nowUnix (number).
// Returns: {valid: bool, caveats: [{condition, value}], error?: string}.
func jsVerifyCaveats(_ js.Value, args []js.Value) any {
	if len(args) < 4 {
		return jsError("verifyCaveats requires 4 args: macaroonB64, rootKeyHex, targetService, nowUnix")
	}

	macaroonB64 := args[0].String()
	rootKeyHex := args[1].String()
	targetService := args[2].String()
	nowUnix := int64(args[3].Float())

	rootKey, err := hex.DecodeString(rootKeyHex)
	if err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("invalid rootKey hex: %v", err))
	}

	macBytes, err := base64.StdEncoding.DecodeString(macaroonB64)
	if err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("invalid macaroon base64: %v", err))
	}

	var mac macaroon.Macaroon
	if err := mac.UnmarshalBinary(macBytes); err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("failed to unmarshal macaroon: %v", err))
	}

	// Verify signature first.
	rawCaveats, err := mac.VerifySignature(rootKey, nil)
	if err != nil {
		return jsVerifyResult(false, nil, fmt.Sprintf("signature verification failed: %v", err))
	}

	// Decode caveats.
	var caveats []l402.Caveat
	for _, raw := range rawCaveats {
		caveat, decErr := l402.DecodeCaveat(raw)
		if decErr != nil {
			continue
		}
		caveats = append(caveats, caveat)
	}

	// Build satisfiers and verify.
	nowFn := func() time.Time {
		return time.Unix(nowUnix, 0)
	}

	err = l402.VerifyCaveats(
		caveats,
		l402.NewServicesSatisfier(targetService),
		l402.NewTimeoutSatisfier(targetService, nowFn),
	)
	if err != nil {
		return jsVerifyResult(false, caveats, err.Error())
	}

	return jsVerifyResult(true, caveats, "")
}

// jsAddFirstPartyCaveats adds caveats to an existing macaroon and returns
// the updated macaroon.
//
// Args: macaroonB64 (string), caveatsJSON (Array of {condition, value}).
// Returns: updated macaroonB64 string or {error: string}.
func jsAddFirstPartyCaveats(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("addFirstPartyCaveats requires 2 args: macaroonB64, caveatsJSON")
	}

	macaroonB64 := args[0].String()
	caveatsArr := args[1]

	macBytes, err := base64.StdEncoding.DecodeString(macaroonB64)
	if err != nil {
		return jsError(fmt.Sprintf("invalid macaroon base64: %v", err))
	}

	var mac macaroon.Macaroon
	if err := mac.UnmarshalBinary(macBytes); err != nil {
		return jsError(fmt.Sprintf("failed to unmarshal macaroon: %v", err))
	}

	caveats := parseCaveatsFromJS(caveatsArr)
	if err := l402.AddFirstPartyCaveats(&mac, caveats...); err != nil {
		return jsError(fmt.Sprintf("failed to add caveats: %v", err))
	}

	updatedBytes, err := mac.MarshalBinary()
	if err != nil {
		return jsError(fmt.Sprintf("failed to marshal updated macaroon: %v", err))
	}

	return base64.StdEncoding.EncodeToString(updatedBytes)
}

// parseCaveatsFromJS converts a JS array of {condition, value} objects to
// l402.Caveat slices.
func parseCaveatsFromJS(arr js.Value) []l402.Caveat {
	length := arr.Length()
	caveats := make([]l402.Caveat, 0, length)

	for i := 0; i < length; i++ {
		item := arr.Index(i)
		caveats = append(caveats, l402.Caveat{
			Condition: item.Get("condition").String(),
			Value:     item.Get("value").String(),
		})
	}

	return caveats
}

// jsError creates a JS object with an error field.
func jsError(msg string) js.Value {
	result := js.Global().Get("Object").New()
	result.Set("error", msg)
	return result
}

// jsVerifyResult creates a JS verification result object.
func jsVerifyResult(valid bool, caveats []l402.Caveat, errMsg string) js.Value {
	result := js.Global().Get("Object").New()
	result.Set("valid", valid)

	if errMsg != "" {
		result.Set("error", errMsg)
	}

	if caveats != nil {
		caveatsArr := js.Global().Get("Array").New(len(caveats))
		for i, c := range caveats {
			obj := js.Global().Get("Object").New()
			obj.Set("condition", c.Condition)
			obj.Set("value", c.Value)
			caveatsArr.SetIndex(i, obj)
		}
		result.Set("caveats", caveatsArr)
	}

	return result
}
