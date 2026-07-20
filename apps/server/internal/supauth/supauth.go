// Package supauth validates Supabase Auth (GoTrue) access tokens presented by
// clients at connection time. Tokens are HS256 JWTs signed with the project's
// JWT secret (Supabase dashboard: Settings -> API); the subject is the Supabase
// user's UUID and the audience must be "authenticated" (the "anon" audience used
// by pre-signup keys is rejected).
//
// If a project migrates to the newer asymmetric signing keys, this package is
// the single place that would switch to JWKS verification; callers only see
// Validate.
package supauth

import (
	"errors"
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

// Validate parses and verifies a Supabase access token using the project JWT
// secret. Returns the user id (sub claim) if valid, or an error if the token is
// malformed, expired, signed with a different secret or algorithm, or carries a
// non-"authenticated" audience.
func Validate(secret []byte, token string) (string, error) {
	if len(secret) == 0 {
		return "", errors.New("secret cannot be empty")
	}
	if token == "" {
		return "", errors.New("token cannot be empty")
	}

	parsedToken, err := jwt.ParseWithClaims(
		token,
		&jwt.MapClaims{},
		func(tok *jwt.Token) (interface{}, error) {
			// Reject any algorithm other than HS256
			if tok.Method != jwt.SigningMethodHS256 {
				return nil, fmt.Errorf("unexpected signing method: %v", tok.Method)
			}
			return secret, nil
		},
	)
	if err != nil {
		return "", fmt.Errorf("failed to parse token: %w", err)
	}

	if !parsedToken.Valid {
		return "", errors.New("token is invalid")
	}

	claims, ok := parsedToken.Claims.(*jwt.MapClaims)
	if !ok {
		return "", errors.New("failed to extract claims")
	}

	// Supabase issues aud="authenticated" for signed-in users; the anon key's
	// audience ("anon") proves no identity and is rejected.
	return subjectFromClaims(*claims)
}
