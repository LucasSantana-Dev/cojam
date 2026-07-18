// Package connauth provides signed connection identity tokens for unforgeable
// anonymous client authentication. Tokens are HS256 JWTs with {sub, exp, iat}
// claims, validated at connection time.
package connauth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Mint creates an HS256 JWT token with the given subject (sub), expiration (ttl),
// and signs it with the secret. Returns the token string or an error.
func Mint(secret []byte, sub string, ttl time.Duration) (string, error) {
	if len(secret) == 0 {
		return "", errors.New("secret cannot be empty")
	}
	if sub == "" {
		return "", errors.New("sub cannot be empty")
	}

	now := time.Now()
	claims := jwt.MapClaims{
		"sub": sub,
		"iat": now.Unix(),
		"exp": now.Add(ttl).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedToken, err := token.SignedString(secret)
	if err != nil {
		return "", fmt.Errorf("failed to sign token: %w", err)
	}

	return signedToken, nil
}

// Validate parses and verifies an HS256 JWT token using the given secret.
// Returns the subject (sub) claim if valid, or an error if:
// - the token is malformed
// - the signature is invalid
// - the token has expired
// - the algorithm is not HS256
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

	sub, ok := (*claims)["sub"].(string)
	if !ok || sub == "" {
		return "", errors.New("missing or invalid sub claim")
	}

	return sub, nil
}

// NewSub generates a fresh anonymous stable identity using 16 random bytes
// base64url-encoded. Two NewSub() calls will produce different identities.
func NewSub() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback: if crypto/rand fails (should never happen), return a dummy
		// This should not happen in production; panic would be more honest.
		panic(fmt.Sprintf("failed to generate random bytes: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
