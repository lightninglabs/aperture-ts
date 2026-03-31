package l402

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Satisfier provides a generic interface to satisfy a caveat based on its
// condition.
type Satisfier struct {
	// Condition is the condition of the caveat we'll attempt to satisfy.
	Condition string

	// SatisfyPrevious ensures a caveat is in accordance with a previous one
	// with the same condition.
	SatisfyPrevious func(previous Caveat, current Caveat) error

	// SatisfyFinal satisfies the final caveat of an L402.
	SatisfyFinal func(Caveat) error
}

// NewServicesSatisfier implements a satisfier to determine whether the target
// service is authorized for a given L402.
func NewServicesSatisfier(targetService string) Satisfier {
	return Satisfier{
		Condition: CondServices,
		SatisfyPrevious: func(prev, cur Caveat) error {
			prevServices, err := decodeServicesCaveatValue(prev.Value)
			if err != nil {
				return err
			}
			prevAllowed := make(map[string]struct{}, len(prevServices))
			for _, service := range prevServices {
				prevAllowed[service.Name] = struct{}{}
			}

			currentServices, err := decodeServicesCaveatValue(cur.Value)
			if err != nil {
				return err
			}
			for _, service := range currentServices {
				if _, ok := prevAllowed[service.Name]; !ok {
					return fmt.Errorf("service %v not "+
						"previously allowed", service)
				}
			}

			return nil
		},
		SatisfyFinal: func(c Caveat) error {
			services, err := decodeServicesCaveatValue(c.Value)
			if err != nil {
				return err
			}
			for _, service := range services {
				if service.Name == targetService {
					return nil
				}
			}
			return fmt.Errorf("target service %v not authorized",
				targetService)
		},
	}
}

// NewCapabilitiesSatisfier implements a satisfier to determine whether the
// target capability for a service is authorized for a given L402.
func NewCapabilitiesSatisfier(service string,
	targetCapability string) Satisfier {

	return Satisfier{
		Condition: service + CondCapabilitiesSuffix,
		SatisfyPrevious: func(prev, cur Caveat) error {
			prevCapabilities := strings.Split(prev.Value, ",")
			allowed := make(map[string]struct{}, len(prevCapabilities))
			for _, capability := range prevCapabilities {
				allowed[capability] = struct{}{}
			}

			currentCapabilities := strings.Split(cur.Value, ",")
			for _, capability := range currentCapabilities {
				if _, ok := allowed[capability]; !ok {
					return fmt.Errorf("capability %v not "+
						"previously allowed", capability)
				}
			}

			return nil
		},
		SatisfyFinal: func(c Caveat) error {
			capabilities := strings.Split(c.Value, ",")
			for _, capability := range capabilities {
				if capability == targetCapability {
					return nil
				}
			}
			return fmt.Errorf("target capability %v not authorized",
				targetCapability)
		},
	}
}

// NewTimeoutSatisfier checks if an L402 is expired or not.
func NewTimeoutSatisfier(service string, now func() time.Time) Satisfier {
	return Satisfier{
		Condition: service + CondTimeoutSuffix,
		SatisfyPrevious: func(prev, cur Caveat) error {
			prevValue, err := strconv.ParseInt(prev.Value, 10, 64)
			if err != nil {
				return fmt.Errorf("error parsing previous "+
					"caveat value: %w", err)
			}

			currValue, err := strconv.ParseInt(cur.Value, 10, 64)
			if err != nil {
				return fmt.Errorf("error parsing caveat "+
					"value: %w", err)
			}

			prevTime := time.Unix(prevValue, 0)
			currTime := time.Unix(currValue, 0)

			if prevTime.Before(currTime) {
				return fmt.Errorf("%s caveat violates "+
					"increasing restrictiveness",
					service+CondTimeoutSuffix)
			}

			return nil
		},
		SatisfyFinal: func(c Caveat) error {
			expirationTimestamp, err := strconv.ParseInt(
				c.Value, 10, 64,
			)
			if err != nil {
				return fmt.Errorf("caveat value not a valid "+
					"integer: %v", err)
			}

			expirationTime := time.Unix(expirationTimestamp, 0)

			if now().Before(expirationTime) {
				return nil
			}

			return fmt.Errorf("not authorized to access " +
				"service. L402 has expired")
		},
	}
}
