// Package spotifyauth provides a single cached Spotify client-credentials token
// shared across the application (match and playlist modules).
package spotifyauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
)

var (
	// ErrNotConfigured is returned when Spotify credentials are not set.
	ErrNotConfigured = errors.New("spotify not configured")

	// ClientID and ClientSecret are read from env, but exposed as package vars
	// for test injection.
	ClientID     = os.Getenv("SPOTIFY_CLIENT_ID")
	ClientSecret = os.Getenv("SPOTIFY_CLIENT_SECRET")

	// TokenURL is the Spotify OAuth token endpoint.
	TokenURL = "https://accounts.spotify.com/api/token"

	// Client is the HTTP client used for token requests (injected for testing).
	Client = httpx.Client

	// tokenCache holds a cached access token with expiry info.
	tokenCache = &tokenCacheEntry{}
)

// tokenCacheEntry holds a cached access token with expiry info.
type tokenCacheEntry struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// Token returns a valid Spotify access token, using a cached token if available
// and not expired. If the cache is stale or empty, it fetches a new token via
// the client-credentials flow. Returns ErrNotConfigured if ClientID or ClientSecret
// are empty.
func Token(ctx context.Context) (string, error) {
	tokenCache.mu.Lock()
	defer tokenCache.mu.Unlock()

	// Return cached token if not expired (with 30s skew for safety)
	if tokenCache.token != "" && time.Now().Before(tokenCache.expiresAt.Add(-30*time.Second)) {
		return tokenCache.token, nil
	}

	// Check configuration before requesting
	if ClientID == "" || ClientSecret == "" {
		return "", ErrNotConfigured
	}

	// Fetch new token
	req, err := http.NewRequestWithContext(ctx, "POST", TokenURL,
		strings.NewReader("grant_type=client_credentials"))
	if err != nil {
		return "", fmt.Errorf("failed to create token request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(ClientID, ClientSecret)

	resp, err := Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Drain and discard body to avoid leaking
		io.Copy(io.Discard, io.LimitReader(resp.Body, httpx.MaxResponseBytes))
		return "", fmt.Errorf("unexpected token status %d", resp.StatusCode)
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, httpx.MaxResponseBytes)).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("failed to decode token response: %w", err)
	}

	tokenCache.token = tokenResp.AccessToken
	tokenCache.expiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)

	return tokenCache.token, nil
}

// ResetCache clears the cached token; used by tests to ensure fresh state between test cases.
func ResetCache() {
	tokenCache.mu.Lock()
	defer tokenCache.mu.Unlock()
	tokenCache.token = ""
	tokenCache.expiresAt = time.Time{}
}
