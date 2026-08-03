package appletoken

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// tokenTTL is the signed token lifetime (Apple allows up to 180 days; 12h is
// the repo's chosen bound). The cache re-signs once the cached token enters
// its last cacheRefreshMargin, so clients never receive a token about to die.
const (
	tokenTTL           = 12 * time.Hour
	cacheRefreshMargin = time.Hour
)

// now is a var so tests can advance the clock and prove cache expiry.
var now = time.Now

var cache struct {
	mu     sync.Mutex
	key    string
	token  string
	expiry time.Time
}

// BuildToken returns an Apple Music developer token (ES256), re-signing at
// most once per TTL-minus-margin window; calls within the window return the
// cached token instead of re-reading the key and re-signing per request.
// It reads env vars: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY_P8
// Returns 501 error if any credential is missing
func BuildToken() (string, error) {
	teamID := os.Getenv("APPLE_TEAM_ID")
	keyID := os.Getenv("APPLE_KEY_ID")
	keyPath := os.Getenv("APPLE_PRIVATE_KEY_P8")

	if teamID == "" || keyID == "" || keyPath == "" {
		return "", ErrNotConfigured
	}

	key := teamID + "|" + keyID + "|" + keyPath
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.token != "" && cache.key == key && now().Before(cache.expiry.Add(-cacheRefreshMargin)) {
		return cache.token, nil
	}

	tokenString, expiry, err := signToken(teamID, keyID, keyPath)
	if err != nil {
		return "", err
	}
	cache.key = key
	cache.token = tokenString
	cache.expiry = expiry
	return tokenString, nil
}

func signToken(teamID, keyID, keyPath string) (string, time.Time, error) {
	// Read private key from file
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to read private key: %w", err)
	}

	// Parse PEM-encoded private key
	block, _ := pem.Decode(keyData)
	if block == nil {
		return "", time.Time{}, fmt.Errorf("failed to decode PEM block")
	}

	// Apple portal .p8 files are PKCS#8 ("BEGIN PRIVATE KEY"); SEC1 kept as fallback
	var privKey *ecdsa.PrivateKey
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		ec, ok := k.(*ecdsa.PrivateKey)
		if !ok {
			return "", time.Time{}, fmt.Errorf("private key is %T, want *ecdsa.PrivateKey", k)
		}
		privKey = ec
	} else if k, secErr := x509.ParseECPrivateKey(block.Bytes); secErr == nil {
		privKey = k
	} else {
		return "", time.Time{}, fmt.Errorf("failed to parse private key (PKCS#8: %v): %w", err, secErr)
	}

	// Create token with 12-hour expiration
	t := now()
	expiry := t.Add(tokenTTL)
	claims := jwt.MapClaims{
		"iss": teamID,
		"iat": t.Unix(),
		"exp": expiry.Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = keyID

	// Sign token
	tokenString, err := token.SignedString(privKey)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to sign token: %w", err)
	}

	return tokenString, expiry, nil
}
