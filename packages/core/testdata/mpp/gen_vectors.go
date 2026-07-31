//go:build ignore

// gen_vectors emits cross-language test vectors produced by the Go reference
// implementation of the Machine Payments Protocol wire encodings, which lives
// in the aperture repository's mpp package. The TypeScript implementation in
// packages/core/src/mpp is checked against this output so that a TypeScript
// buyer and a Go seller agree on the bytes.
//
// Run from a scratch module that pulls in the aperture mpp package:
//
//	go mod init mppvec
//	go mod edit -require=github.com/lightninglabs/aperture@v0.0.0
//	go mod edit -replace=github.com/lightninglabs/aperture=/path/to/aperture
//	go mod tidy
//	go run gen_vectors.go > vectors.json
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/lightninglabs/aperture/mpp"
)

type jcsVector struct {
	Name      string `json:"name"`
	Input     string `json:"input"`
	Canonical string `json:"canonical"`
	Encoded   string `json:"encoded"`
}

type b64Vector struct {
	Name    string `json:"name"`
	Bytes   []int  `json:"bytes"`
	Encoded string `json:"encoded"`
}

type challengeVector struct {
	Name      string `json:"name"`
	Secret    string `json:"secret"`
	Realm     string `json:"realm"`
	Method    string `json:"method"`
	Intent    string `json:"intent"`
	Request   string `json:"request"`
	Expires   string `json:"expires"`
	Digest    string `json:"digest"`
	Opaque    string `json:"opaque"`
	HMACInput string `json:"hmacInput"`
	ID        string `json:"id"`
}

type headerVector struct {
	Name   string              `json:"name"`
	Params mpp.ChallengeParams `json:"params"`
	Header string              `json:"header"`
}

type credentialVector struct {
	Name   string `json:"name"`
	Header string `json:"header"`
	JSON   string `json:"json"`
}

type receiptVector struct {
	Name   string `json:"name"`
	Header string `json:"header"`
	JSON   string `json:"json"`
}

type vectors struct {
	JCS         []jcsVector        `json:"jcs"`
	Base64URL   []b64Vector        `json:"base64url"`
	ChallengeID []challengeVector  `json:"challengeId"`
	Headers     []headerVector     `json:"challengeHeaders"`
	Credentials []credentialVector `json:"credentials"`
	Receipts    []receiptVector    `json:"receipts"`
}

// jcsInputs are raw JSON documents whose canonical form the TypeScript
// implementation must reproduce byte for byte.
var jcsInputs = []struct {
	name  string
	input string
}{
	{"empty object", `{}`},
	{"empty array", `[]`},
	{"reorder keys", `{"z":"last","a":"first","m":"middle"}`},
	{"strip whitespace", `{ "b" : "2" , "a" : "1" }`},
	{"mixed case keys", `{"b":"2","A":"1","a":"3"}`},
	{"numeric string keys", `{"10":"ten","2":"two","1":"one"}`},
	{"nested reorder", `{"outer":{"z":"1","a":"2"}}`},
	{"deeply nested", `{"a":{"b":{"c":"deep"}}}`},
	{"array preserves order", `{"items":["c","a","b"]}`},
	{"array of objects", `{"list":[{"z":"1","a":"2"}]}`},
	{"null and booleans", `{"n":null,"t":true,"f":false}`},
	{"string escapes", `{"s":"hello\nworld\t\"quoted\"\\slash"}`},
	{"unicode string", `{"s":"café"}`},
	{"unicode keys", `{"é":"1","e":"2","z":"3"}`},
	{"control characters", `{"s":"\u0000\u001f\u007f"}`},
	{"short form controls", `{"s":"\b\f\n\r\t"}`},
	{"forward slash and ampersand", `{"s":"a/b&c<d>e"}`},
	{"astral key ordering", `{"\ud83d\ude00":"emoji","\ufffd":"replacement","a":"ascii"}`},
	{"non integer numbers", `{"a":1.5,"b":-0.25,"c":100.0}`},
	{"line separators", `{"s":"a\u2028b\u2029c"}`},
	{"del and high control", `{"s":"\u001b\u009f"}`},
	{"empty key and empty string", `{"":""}`},
	{"integers", `{"a":0,"b":-1,"c":42,"d":1000000}`},
	{"large safe integer", `{"a":9007199254740991}`},
	{
		"charge request",
		`{"amount":"100","currency":"sat","description":"Weather report",` +
			`"methodDetails":{"invoice":"lnbc1u1p...",` +
			`"paymentHash":"bc230847...","network":"mainnet"}}`,
	},
	{
		"session request",
		`{"amount":"2","currency":"sat","description":"LLM token stream",` +
			`"unitType":"token","depositInvoice":"lnbcrt1p5mzfsa...",` +
			`"paymentHash":"7f3a1b2c4d5e6f","depositAmount":"300",` +
			`"idleTimeout":"300"}`,
	},
	{"already canonical", `{"a":"1","b":"2"}`},
	{"top level string", `"hello"`},
	{"top level number", `42`},
	{"top level null", `null`},
	{"top level true", `true`},
	{"nested empty containers", `{"a":{},"b":[],"c":[{}]}`},
}

func buildJCS() []jcsVector {
	out := make([]jcsVector, 0, len(jcsInputs))
	for _, in := range jcsInputs {
		canonical, err := mpp.CanonicalizeJSON([]byte(in.input))
		if err != nil {
			panic(fmt.Sprintf("%s: %v", in.name, err))
		}
		out = append(out, jcsVector{
			Name:      in.name,
			Input:     in.input,
			Canonical: string(canonical),
			Encoded:   mpp.Base64URLEncode(canonical),
		})
	}
	return out
}

func buildBase64URL() []b64Vector {
	inputs := []struct {
		name  string
		bytes []byte
	}{
		{"empty", []byte{}},
		{"simple", []byte("hello")},
		{"url unsafe", []byte{0xff, 0xfe, 0xfd}},
		{"one byte", []byte{0x00}},
		{"two bytes", []byte{0x01, 0x02}},
		{"three bytes", []byte{0x01, 0x02, 0x03}},
		{"json object", []byte(`{"amount":"100","currency":"sat"}`)},
		{"high bytes", []byte{0xfb, 0xff, 0xbf, 0x3e, 0x3f}},
	}

	out := make([]b64Vector, 0, len(inputs))
	for _, in := range inputs {
		ints := make([]int, len(in.bytes))
		for i, b := range in.bytes {
			ints[i] = int(b)
		}
		out = append(out, b64Vector{
			Name:    in.name,
			Bytes:   ints,
			Encoded: mpp.Base64URLEncode(in.bytes),
		})
	}
	return out
}

func buildChallengeIDs() []challengeVector {
	secret := "test-server-secret-key-32-bytes!"
	base := mpp.ChallengeParams{
		Realm:   "api.example.com",
		Method:  mpp.MethodLightning,
		Intent:  mpp.IntentCharge,
		Request: "eyJhbW91bnQiOiIxMDAiLCJjdXJyZW5jeSI6InNhdCJ9",
	}

	combos := []struct {
		name   string
		mutate func(p *mpp.ChallengeParams)
		secret string
	}{
		{"required only", func(p *mpp.ChallengeParams) {}, secret},
		{
			"expires only",
			func(p *mpp.ChallengeParams) {
				p.Expires = "2026-03-15T12:05:00Z"
			},
			secret,
		},
		{
			"digest only",
			func(p *mpp.ChallengeParams) {
				p.Digest = "sha-256=:abc:"
			},
			secret,
		},
		{
			"opaque only",
			func(p *mpp.ChallengeParams) {
				p.Opaque = "eyJvcmRlciI6IjEyMyJ9"
			},
			secret,
		},
		{
			"all optional",
			func(p *mpp.ChallengeParams) {
				p.Expires = "2026-03-15T12:05:00Z"
				p.Digest = "sha-256=:abc:"
				p.Opaque = "eyJvcmRlciI6IjEyMyJ9"
			},
			secret,
		},
		{
			"session intent",
			func(p *mpp.ChallengeParams) {
				p.Intent = mpp.IntentSession
				p.Expires = "2026-03-15T12:05:00Z"
			},
			secret,
		},
		{
			"unicode realm",
			func(p *mpp.ChallengeParams) {
				p.Realm = "café.example.com"
			},
			secret,
		},
		{
			"long secret",
			func(p *mpp.ChallengeParams) {},
			"a-much-longer-server-secret-that-exceeds-the-sha256-block-" +
				"size-of-sixty-four-bytes-so-the-hmac-key-is-hashed-first",
		},
		{"empty secret", func(p *mpp.ChallengeParams) {}, ""},
	}

	out := make([]challengeVector, 0, len(combos))
	for _, c := range combos {
		p := base
		c.mutate(&p)
		id := mpp.ComputeChallengeID([]byte(c.secret), &p)

		// Reproduce the pipe-joined HMAC input for the TypeScript side to
		// assert against directly.
		hmacInput := p.Realm + "|" + p.Method + "|" + p.Intent + "|" +
			p.Request + "|" + p.Expires + "|" + p.Digest + "|" + p.Opaque

		out = append(out, challengeVector{
			Name:      c.name,
			Secret:    c.secret,
			Realm:     p.Realm,
			Method:    p.Method,
			Intent:    p.Intent,
			Request:   p.Request,
			Expires:   p.Expires,
			Digest:    p.Digest,
			Opaque:    p.Opaque,
			HMACInput: hmacInput,
			ID:        id,
		})
	}
	return out
}

func buildHeaders() []headerVector {
	inputs := []struct {
		name   string
		params mpp.ChallengeParams
	}{
		{
			"minimal",
			mpp.ChallengeParams{
				ID:      "minimalid",
				Realm:   "example.com",
				Method:  mpp.MethodLightning,
				Intent:  mpp.IntentCharge,
				Request: "eyJ0ZXN0IjoiMSJ9",
			},
		},
		{
			"all params",
			mpp.ChallengeParams{
				ID:          "x7Tg2pLqR9mKvNwY3hBcZa",
				Realm:       "api.example.com",
				Method:      mpp.MethodLightning,
				Intent:      mpp.IntentSession,
				Request:     "eyJ0ZXN0IjoidmFsdWUifQ",
				Expires:     "2026-03-15T12:05:00Z",
				Digest:      "sha-256=:X48E9q:",
				Description: "Test payment",
				Opaque:      "eyJvcmRlcklkIjoiMTIzIn0",
			},
		},
		{
			"description with spaces and comma",
			mpp.ChallengeParams{
				ID:          "descid",
				Realm:       "api.example.com",
				Method:      mpp.MethodLightning,
				Intent:      mpp.IntentCharge,
				Request:     "eyJ0ZXN0IjoiMSJ9",
				Description: "Weather report, hourly",
			},
		},
	}

	out := make([]headerVector, 0, len(inputs))
	for _, in := range inputs {
		h := make(http.Header)
		p := in.params
		mpp.SetChallengeHeader(h, &p)
		out = append(out, headerVector{
			Name:   in.name,
			Params: p,
			Header: h.Get("WWW-Authenticate"),
		})
	}
	return out
}

func buildCredentials() []credentialVector {
	inputs := []struct {
		name string
		cred *mpp.Credential
	}{
		{
			"charge",
			&mpp.Credential{
				Challenge: mpp.ChallengeEcho{
					ID:      "kM9xPqWvT2nJrHsY4aDfEb",
					Realm:   "api.example.com",
					Method:  mpp.MethodLightning,
					Intent:  mpp.IntentCharge,
					Request: "eyJhbW91bnQiOiIxMDAifQ",
					Expires: "2026-03-15T12:05:00Z",
				},
				Payload: json.RawMessage(
					`{"preimage":"a3f1e2d4b5c6a7e8"}`,
				),
			},
		},
		{
			"session bearer",
			&mpp.Credential{
				Challenge: mpp.ChallengeEcho{
					ID:      "pR4mNvKqU8wLsYtZ1bCdFg",
					Realm:   "api.example.com",
					Method:  mpp.MethodLightning,
					Intent:  mpp.IntentSession,
					Request: "eyJhbW91bnQiOiIyIn0",
				},
				Payload: json.RawMessage(
					`{"action":"bearer","sessionId":"7f3a1b2c4d5e6f"}`,
				),
			},
		},
		{
			"with source",
			&mpp.Credential{
				Challenge: mpp.ChallengeEcho{
					ID:      "srcid",
					Realm:   "example.com",
					Method:  mpp.MethodLightning,
					Intent:  mpp.IntentCharge,
					Request: "eyJ0ZXN0IjoiMSJ9",
				},
				Source: "did:key:z6MkhaXgBZDvotDkL5257faiztiG",
				Payload: json.RawMessage(
					`{"preimage":"deadbeef"}`,
				),
			},
		},
	}

	out := make([]credentialVector, 0, len(inputs))
	for _, in := range inputs {
		data, err := json.Marshal(in.cred)
		if err != nil {
			panic(err)
		}
		out = append(out, credentialVector{
			Name:   in.name,
			Header: mpp.AuthScheme + " " + mpp.Base64URLEncode(data),
			JSON:   string(data),
		})
	}
	return out
}

func buildReceipts() []receiptVector {
	out := []receiptVector{}

	base := &mpp.Receipt{
		Status:      mpp.ReceiptStatusSuccess,
		Method:      mpp.MethodLightning,
		Timestamp:   "2026-03-10T21:00:00Z",
		Reference:   "bc230847abcdef1234567890",
		ChallengeID: "kM9xPqWvT2nJrHsY4aDfEb",
	}
	h := make(http.Header)
	if err := mpp.SetReceiptHeader(h, base); err != nil {
		panic(err)
	}
	data, _ := json.Marshal(base)
	out = append(out, receiptVector{
		Name:   "charge",
		Header: h.Get(mpp.HeaderPaymentReceipt),
		JSON:   string(data),
	})

	closeReceipt := &mpp.SessionReceipt{
		Method:       mpp.MethodLightning,
		Reference:    "7f3a1b2c4d5e6f",
		Status:       mpp.ReceiptStatusSuccess,
		Timestamp:    "2026-03-10T21:00:00Z",
		RefundSats:   140,
		RefundStatus: "succeeded",
	}
	closeData, _ := json.Marshal(closeReceipt)
	out = append(out, receiptVector{
		Name:   "session close refunded",
		Header: mpp.Base64URLEncode(closeData),
		JSON:   string(closeData),
	})

	skipped := &mpp.SessionReceipt{
		Method:       mpp.MethodLightning,
		Reference:    "7f3a1b2c4d5e6f",
		Status:       mpp.ReceiptStatusSuccess,
		Timestamp:    "2026-03-10T21:00:00Z",
		RefundStatus: "skipped",
	}
	skippedData, _ := json.Marshal(skipped)
	out = append(out, receiptVector{
		Name:   "session close skipped",
		Header: mpp.Base64URLEncode(skippedData),
		JSON:   string(skippedData),
	})

	return out
}

func main() {
	v := vectors{
		JCS:         buildJCS(),
		Base64URL:   buildBase64URL(),
		ChallengeID: buildChallengeIDs(),
		Headers:     buildHeaders(),
		Credentials: buildCredentials(),
		Receipts:    buildReceipts(),
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
}
