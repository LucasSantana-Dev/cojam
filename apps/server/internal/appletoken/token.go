package appletoken

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// BuildToken creates an Apple Music developer token (ES256)
// It reads env vars: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY_P8
// Returns 501 error if any credential is missing
func BuildToken() (string, error) {
	teamID := os.Getenv("APPLE_TEAM_ID")
	keyID := os.Getenv("APPLE_KEY_ID")
	keyPath := os.Getenv("APPLE_PRIVATE_KEY_P8")

	if teamID == "" || keyID == "" || keyPath == "" {
		return "", ErrNotConfigured
	}

	// Read private key from file
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return "", fmt.Errorf("failed to read private key: %w", err)
	}

	// Parse PEM-encoded private key
	block, _ := pem.Decode(keyData)
	if block == nil {
		return "", fmt.Errorf("failed to decode PEM block")
	}

	privKey, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("failed to parse EC private key: %w", err)
	}

	// Create token with 12-hour expiration
	now := time.Now()
	claims := jwt.MapClaims{
		"iss": teamID,
		"iat": now.Unix(),
		"exp": now.Add(12 * time.Hour).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = keyID

	// Sign token
	tokenString, err := token.SignedString(privKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign token: %w", err)
	}

	return tokenString, nil
}
