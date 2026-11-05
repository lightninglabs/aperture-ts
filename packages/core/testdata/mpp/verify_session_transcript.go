//go:build ignore

// verify_session_transcript drives the credentials a TypeScript payingFetch
// run produced through the reference session authenticator, exactly as an
// aperture deployment would.
//
// verify_transcript.go proves the codecs agree; this proves the state
// machine does. The authenticator is the component that decides whether a
// session ever exists and whether its deposit ever comes back, so a buyer
// whose open, bearer, topUp, or close credential it refuses has not hit an
// interop nit, it has stranded the deposit. Beyond replaying the happy path
// in order, this also checks the transitions the server defines around
// replays: a bearer before its open is refused, a replayed open is refused,
// a replayed topUp is accepted without crediting twice, and a close only
// works once.
//
// See README.md for how to run it.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/lightninglabs/aperture/auth"
	"github.com/lightningnetwork/lnd/lnrpc"
	"github.com/lightningnetwork/lnd/lntypes"
)

type exchange struct {
	Name          string `json:"name"`
	Authorization string `json:"authorization"`
	ExpectAccept  bool   `json:"expectAccept"`
}

type transcript struct {
	Secret        string     `json:"secret"`
	Realm         string     `json:"realm"`
	ReturnInvoice string     `json:"returnInvoice"`
	Exchanges     []exchange `json:"exchanges"`
}

// memChecker treats every invoice as settled, standing in for lnd: the
// transcript's payments happened in the emitting process's wallet fake, and
// what is under test here is the credential handling above the invoice
// lookup, not the lookup.
type memChecker struct{}

func (memChecker) VerifyInvoiceStatus(lntypes.Hash, lnrpc.Invoice_InvoiceState,
	time.Duration) error {

	return nil
}

// memStore is an in-memory auth.SessionStore with the same once-only
// semantics the SQL store enforces: a payment hash funds at most one thing,
// claimed atomically with the balance change.
type memStore struct {
	sessions map[string]*auth.Session
	credited map[string]string
}

func newMemStore() *memStore {
	return &memStore{
		sessions: make(map[string]*auth.Session),
		credited: make(map[string]string),
	}
}

func (m *memStore) CreateSession(_ context.Context,
	session *auth.Session) error {

	hash := hex.EncodeToString(session.PaymentHash[:])
	if _, seen := m.credited[hash]; seen {
		return fmt.Errorf("deposit payment hash %s has already been "+
			"credited", hash)
	}

	m.credited[hash] = session.SessionID
	m.sessions[session.SessionID] = session
	return nil
}

func (m *memStore) GetSession(_ context.Context,
	sessionID string) (*auth.Session, error) {

	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session %s not found", sessionID)
	}
	return session, nil
}

func (m *memStore) CreditSession(_ context.Context, sessionID string,
	paymentHash lntypes.Hash, addSats int64) (auth.CreditOutcome, error) {

	session, ok := m.sessions[sessionID]
	if !ok {
		return 0, fmt.Errorf("session %s not found", sessionID)
	}

	hash := hex.EncodeToString(paymentHash[:])
	if creditedTo, seen := m.credited[hash]; seen {
		if creditedTo == sessionID {
			return auth.CreditReplayed, nil
		}
		return auth.CreditForeign, nil
	}

	m.credited[hash] = sessionID
	session.DepositSats += addSats
	return auth.CreditApplied, nil
}

func (m *memStore) DeductSessionBalance(_ context.Context, sessionID string,
	amount int64) error {

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session %s not found", sessionID)
	}
	if session.SpentSats+amount > session.DepositSats {
		return fmt.Errorf("insufficient balance")
	}

	session.SpentSats += amount
	return nil
}

func (m *memStore) CloseSession(_ context.Context, sessionID string) error {
	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session %s not found", sessionID)
	}

	session.Status = "closed"
	return nil
}

func (m *memStore) SettleSessionBalance(_ context.Context, sessionID string,
	deltaSats int64) (int64, error) {

	session, ok := m.sessions[sessionID]
	if !ok {
		return 0, fmt.Errorf("session %s not found", sessionID)
	}

	spent := session.SpentSats + deltaSats
	if spent < 0 {
		spent = 0
	}
	if spent > session.DepositSats {
		spent = session.DepositSats
	}

	session.SpentSats = spent
	return spent, nil
}

func (m *memStore) CloseSessionAndGetBalance(_ context.Context,
	sessionID string) (int64, error) {

	session, ok := m.sessions[sessionID]
	if !ok {
		return 0, fmt.Errorf("session %s not found", sessionID)
	}
	if session.Status != "open" {
		return 0, fmt.Errorf("session %s is not open", sessionID)
	}

	session.Status = "closed"
	return session.DepositSats - session.SpentSats, nil
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

	find := func(name string) exchange {
		for _, ex := range t.Exchanges {
			if ex.Name == name {
				return ex
			}
		}
		panic(fmt.Sprintf("transcript has no %q exchange", name))
	}

	failures := 0
	report := func(name string, got, want bool) {
		if got == want {
			fmt.Printf("ok   %-22s accept=%v\n", name, got)
			return
		}
		fmt.Printf("FAIL %-22s accept=%v, want %v\n", name, got, want)
		failures++
	}

	newAuthenticator := func() *auth.MPPSessionAuthenticator {
		return auth.NewMPPSessionAuthenticator(&auth.MPPSessionConfig{
			Checker:      memChecker{},
			SessionStore: newMemStore(),
			Realm:        t.Realm,
			HMACSecret:   []byte(t.Secret),
			Network:      "regtest",
		})
	}

	accept := func(a *auth.MPPSessionAuthenticator, ex exchange) bool {
		header := make(http.Header)
		header.Set("Authorization", ex.Authorization)
		return a.Accept(&header, "service")
	}

	// A bearer presented before its open names a session the server has
	// never heard of, and must be refused: this is the transition whose
	// absence in a buyer strands the deposit silently.
	early := newAuthenticator()
	report("bearer before open", accept(early, find("bearer")), false)

	// The happy path, in the order the buyer produced it.
	a := newAuthenticator()
	for _, ex := range t.Exchanges {
		report(ex.Name, accept(a, ex), ex.ExpectAccept)
	}

	// The replay transitions the server defines. The close above has
	// already closed the session, so the replays run against a fresh
	// authenticator wound forward to just before the close.
	b := newAuthenticator()
	for _, name := range []string{"open", "bearer", "topUp"} {
		if !accept(b, find(name)) {
			fmt.Printf("FAIL rewind %-15s refused\n", name)
			failures++
		}
	}
	report("replayed open", accept(b, find("open")), false)
	report("replayed topUp", accept(b, find("topUp")), true)
	report("close", accept(b, find("close")), true)
	report("replayed close", accept(b, find("close")), false)

	if failures > 0 {
		fmt.Printf("\n%d failure(s)\n", failures)
		os.Exit(1)
	}
	fmt.Printf("\nsession transcript verified\n")
}
