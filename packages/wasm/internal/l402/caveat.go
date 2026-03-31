// Package l402 is a minimal vendored subset of github.com/lightninglabs/aperture/l402
// containing only the caveat, satisfier, and service logic needed for the WASM
// bridge. This avoids pulling in lnd/lnrpc transitive dependencies that don't
// compile to WASM.
//
// Source: github.com/lightninglabs/aperture v0.5.0, l402/ package.
package l402

import (
	"errors"
	"fmt"
	"strings"

	"gopkg.in/macaroon.v2"
)

const (
	// PreimageKey is the key used for a payment preimage caveat.
	PreimageKey = "preimage"
)

var (
	// ErrInvalidCaveat is an error returned when we attempt to decode a
	// caveat with an invalid format.
	ErrInvalidCaveat = errors.New("caveat must be of the form " +
		"\"condition=value\"")
)

// Caveat is a predicate that can be applied to an L402 in order to restrict its
// use in some form.
type Caveat struct {
	// Condition serves as a way to identify a caveat and how to satisfy it.
	Condition string

	// Value is what will be used to satisfy a caveat.
	Value string
}

// NewCaveat constructs a new caveat with the given condition and value.
func NewCaveat(condition string, value string) Caveat {
	return Caveat{Condition: condition, Value: value}
}

// String returns a user-friendly view of a caveat.
func (c Caveat) String() string {
	return EncodeCaveat(c)
}

// EncodeCaveat encodes a caveat into its string representation.
func EncodeCaveat(c Caveat) string {
	return fmt.Sprintf("%v=%v", c.Condition, c.Value)
}

// DecodeCaveat decodes a caveat from its string representation.
func DecodeCaveat(s string) (Caveat, error) {
	parts := strings.SplitN(s, "=", 2)
	if len(parts) != 2 {
		return Caveat{}, ErrInvalidCaveat
	}
	return Caveat{Condition: parts[0], Value: parts[1]}, nil
}

// AddFirstPartyCaveats adds a set of caveats as first-party caveats to a
// macaroon.
func AddFirstPartyCaveats(m *macaroon.Macaroon, caveats ...Caveat) error {
	for _, c := range caveats {
		rawCaveat := []byte(EncodeCaveat(c))
		if err := m.AddFirstPartyCaveat(rawCaveat); err != nil {
			return err
		}
	}

	return nil
}

// HasCaveat checks whether the given macaroon has a caveat with the given
// condition, and if so, returns its value.
func HasCaveat(m *macaroon.Macaroon, cond string) (string, bool) {
	var value *string
	for _, rawCaveat := range m.Caveats() {
		caveat, err := DecodeCaveat(string(rawCaveat.Id))
		if err != nil {
			continue
		}
		if caveat.Condition == cond {
			value = &caveat.Value
		}
	}

	if value == nil {
		return "", false
	}
	return *value, true
}

// VerifyCaveats determines whether every relevant caveat of an L402 holds true.
func VerifyCaveats(caveats []Caveat, satisfiers ...Satisfier) error {
	caveatSatisfiers := make(map[string]Satisfier, len(satisfiers))
	for _, satisfier := range satisfiers {
		caveatSatisfiers[satisfier.Condition] = satisfier
	}
	relevantCaveats := make(map[string][]Caveat)
	for _, caveat := range caveats {
		if _, ok := caveatSatisfiers[caveat.Condition]; !ok {
			continue
		}
		relevantCaveats[caveat.Condition] = append(
			relevantCaveats[caveat.Condition], caveat,
		)
	}

	for condition, caveats := range relevantCaveats {
		satisfier := caveatSatisfiers[condition]

		for i, j := 0, 1; j < len(caveats); i, j = i+1, j+1 {
			prevCaveat := caveats[i]
			curCaveat := caveats[j]
			err := satisfier.SatisfyPrevious(prevCaveat, curCaveat)
			if err != nil {
				return err
			}
		}

		err := satisfier.SatisfyFinal(caveats[len(caveats)-1])
		if err != nil {
			return err
		}
	}

	return nil
}
