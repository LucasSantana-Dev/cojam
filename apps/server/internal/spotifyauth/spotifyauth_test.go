package spotifyauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestToken_NotConfigured(t *testing.T) {
	oldID, oldSecret := ClientID, ClientSecret
	defer func() {
		ClientID, ClientSecret = oldID, oldSecret
		ResetCache()
	}()

	ClientID = ""
	ClientSecret = ""
	ResetCache()

	_, err := Token(context.Background())
	if err != ErrNotConfigured {
		t.Fatalf("Token() = _, %v, want ErrNotConfigured", err)
	}
}

func TestToken_Fetches(t *testing.T) {
	oldID, oldSecret := ClientID, ClientSecret
	oldURL, oldClient := TokenURL, Client
	defer func() {
		ClientID, ClientSecret = oldID, oldSecret
		TokenURL, Client = oldURL, oldClient
		ResetCache()
	}()

	var hitCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hitCount, 1)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "tok123",
			"expires_in":   3600,
			"token_type":   "Bearer",
		})
	}))
	defer srv.Close()

	ClientID = "id"
	ClientSecret = "secret"
	TokenURL = srv.URL
	Client = http.DefaultClient
	ResetCache()

	token, err := Token(context.Background())
	if err != nil {
		t.Fatalf("Token() = _, %v, want nil", err)
	}
	if token != "tok123" {
		t.Fatalf("Token() = %q, want tok123", token)
	}
	if atomic.LoadInt32(&hitCount) != 1 {
		t.Fatalf("token endpoint hit %d times, want 1", hitCount)
	}
}

func TestToken_Cached(t *testing.T) {
	oldID, oldSecret := ClientID, ClientSecret
	oldURL, oldClient := TokenURL, Client
	defer func() {
		ClientID, ClientSecret = oldID, oldSecret
		TokenURL, Client = oldURL, oldClient
		ResetCache()
	}()

	var hitCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hitCount, 1)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "tok456",
			"expires_in":   3600,
			"token_type":   "Bearer",
		})
	}))
	defer srv.Close()

	ClientID = "id"
	ClientSecret = "secret"
	TokenURL = srv.URL
	Client = http.DefaultClient
	ResetCache()

	// First call: fetches
	token1, err := Token(context.Background())
	if err != nil {
		t.Fatalf("first Token() failed: %v", err)
	}

	// Second call: should be cached
	token2, err := Token(context.Background())
	if err != nil {
		t.Fatalf("second Token() failed: %v", err)
	}

	if token1 != token2 {
		t.Fatalf("cached token differs: %q vs %q", token1, token2)
	}

	if atomic.LoadInt32(&hitCount) != 1 {
		t.Fatalf("token endpoint hit %d times, want 1 (cached)", hitCount)
	}
}
