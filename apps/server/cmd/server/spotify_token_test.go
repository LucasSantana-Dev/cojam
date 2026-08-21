package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifytoken"
)

const testRoomSecret = "test-room-auth-secret"

func spotifyTestStore(t *testing.T) spotifytoken.Store {
	t.Helper()
	sealer, err := spotifytoken.NewSealer([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewSealer: %v", err)
	}
	return spotifytoken.NewMemory(sealer)
}

func testConnToken(t *testing.T, sub string) string {
	t.Helper()
	tok, err := connauth.Mint([]byte(testRoomSecret), sub, time.Hour)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	return tok
}

// spotifyStub points spotifyauth at a fake token endpoint and restores it.
func spotifyStub(t *testing.T, status int, body string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	oldURL, oldID, oldSecret := spotifyauth.TokenURL, spotifyauth.ClientID, spotifyauth.ClientSecret
	spotifyauth.TokenURL = srv.URL
	spotifyauth.ClientID, spotifyauth.ClientSecret = "test-id", "test-secret"
	t.Cleanup(func() {
		srv.Close()
		spotifyauth.TokenURL, spotifyauth.ClientID, spotifyauth.ClientSecret = oldURL, oldID, oldSecret
	})
}

func postJSON(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/spotify/token", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func quietLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func limiter() *callerLimiter { return newCallerLimiter(spotifyBurst, spotifyRefill) }

// The whole point: the browser gets an access token and never a refresh token.
func TestSpotifyExchange_NeverReturnsTheRefreshToken(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-1","refresh_token":"RT-SECRET","expires_in":3600,"scope":"streaming"}`)
	store := spotifyTestStore(t)
	h := spotifyExchangeHandler(store, testRoomSecret, quietLogger(), limiter())

	rec := postJSON(h, `{"code":"c","codeVerifier":"v","redirectUri":"https://x/cb","connToken":"`+testConnToken(t, "sub-1")+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "RT-SECRET") {
		t.Fatal("the response leaked the refresh token to the browser")
	}

	var got spotifyAccessResponse
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got.AccessToken != "AT-1" {
		t.Fatalf("expected the access token, got %q", got.AccessToken)
	}

	// And it was filed under the caller's sub.
	stored, err := store.Get(context.Background(), "sub-1")
	if err != nil || stored != "RT-SECRET" {
		t.Fatalf("expected the refresh token stored for sub-1, got %q, %v", stored, err)
	}
}

// The connection JWT is the authorization boundary for both endpoints.
func TestSpotifyExchange_RejectsBadConnToken(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-1","refresh_token":"RT","expires_in":3600}`)
	h := spotifyExchangeHandler(spotifyTestStore(t), testRoomSecret, quietLogger(), limiter())

	for _, tok := range []string{"", "not-a-jwt", testConnToken(t, "sub-1") + "tampered"} {
		rec := postJSON(h, `{"code":"c","codeVerifier":"v","redirectUri":"https://x/cb","connToken":"`+tok+`"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("token %q: expected 401, got %d", tok, rec.Code)
		}
	}
}

func TestSpotifyExchange_RejectsMissingFields(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-1"}`)
	h := spotifyExchangeHandler(spotifyTestStore(t), testRoomSecret, quietLogger(), limiter())
	tok := testConnToken(t, "sub-1")

	for _, body := range []string{
		`{"codeVerifier":"v","redirectUri":"https://x/cb","connToken":"` + tok + `"}`,
		`{"code":"c","redirectUri":"https://x/cb","connToken":"` + tok + `"}`,
		`{"code":"c","codeVerifier":"v","connToken":"` + tok + `"}`,
		`{"code":`,
	} {
		if rec := postJSON(h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: expected 400, got %d", body, rec.Code)
		}
	}
}

func TestSpotifyRefresh_MintsFromStoredToken(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-2","expires_in":3600}`)
	store := spotifyTestStore(t)
	_ = store.Put(context.Background(), "sub-1", "RT-SECRET", time.Now().Add(time.Hour))
	h := spotifyRefreshHandler(store, testRoomSecret, quietLogger(), limiter())

	rec := postJSON(h, `{"connToken":"`+testConnToken(t, "sub-1")+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "RT-SECRET") {
		t.Fatal("the refresh response leaked the refresh token")
	}
}

// A caller cannot reach another identity's stored credential.
func TestSpotifyRefresh_DoesNotCrossIdentities(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-2","expires_in":3600}`)
	store := spotifyTestStore(t)
	_ = store.Put(context.Background(), "sub-victim", "RT-VICTIM", time.Now().Add(time.Hour))
	h := spotifyRefreshHandler(store, testRoomSecret, quietLogger(), limiter())

	rec := postJSON(h, `{"connToken":"`+testConnToken(t, "sub-attacker")+`"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an identity with nothing stored, got %d", rec.Code)
	}
}

func TestSpotifyRefresh_NothingStoredAsksForReconnect(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-2"}`)
	h := spotifyRefreshHandler(spotifyTestStore(t), testRoomSecret, quietLogger(), limiter())

	rec := postJSON(h, `{"connToken":"`+testConnToken(t, "sub-1")+`"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "reconnect") {
		t.Fatalf("expected a reconnect hint, got %s", rec.Body.String())
	}
}

// invalid_grant means the user revoked the grant in Spotify. Retrying can never
// succeed, so the record must be dropped rather than retried forever.
func TestSpotifyRefresh_RevokedGrantDropsTheRecord(t *testing.T) {
	spotifyStub(t, 400, `{"error":"invalid_grant"}`)
	store := spotifyTestStore(t)
	_ = store.Put(context.Background(), "sub-1", "RT-STALE", time.Now().Add(time.Hour))
	h := spotifyRefreshHandler(store, testRoomSecret, quietLogger(), limiter())

	rec := postJSON(h, `{"connToken":"`+testConnToken(t, "sub-1")+`"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 asking for reconnect, got %d", rec.Code)
	}
	if _, err := store.Get(context.Background(), "sub-1"); err == nil {
		t.Fatal("a revoked grant must not leave the record in place")
	}
}

// Spotify rotates the refresh token on use; missing the rotation breaks the
// next refresh against a token Spotify has retired.
func TestSpotifyRefresh_PersistsRotatedToken(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT-2","refresh_token":"RT-ROTATED","expires_in":3600}`)
	store := spotifyTestStore(t)
	_ = store.Put(context.Background(), "sub-1", "RT-OLD", time.Now().Add(time.Hour))
	h := spotifyRefreshHandler(store, testRoomSecret, quietLogger(), limiter())

	if rec := postJSON(h, `{"connToken":"`+testConnToken(t, "sub-1")+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	got, err := store.Get(context.Background(), "sub-1")
	if err != nil || got != "RT-ROTATED" {
		t.Fatalf("expected the rotated token persisted, got %q, %v", got, err)
	}
}

func TestSpotifyEndpoints_NotConfigured(t *testing.T) {
	oldID, oldSecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	spotifyauth.ClientID, spotifyauth.ClientSecret = "", ""
	defer func() { spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret }()

	store := spotifyTestStore(t)
	for _, h := range []http.HandlerFunc{
		spotifyExchangeHandler(store, testRoomSecret, quietLogger(), limiter()),
		spotifyRefreshHandler(store, testRoomSecret, quietLogger(), limiter()),
	} {
		if rec := postJSON(h, `{}`); rec.Code != http.StatusNotImplemented {
			t.Errorf("expected 501 when Spotify is unconfigured, got %d", rec.Code)
		}
	}
}

func TestSpotifyEndpoints_RateLimited(t *testing.T) {
	spotifyStub(t, 200, `{"access_token":"AT","expires_in":3600}`)
	h := spotifyExchangeHandler(spotifyTestStore(t), testRoomSecret, quietLogger(), limiter())
	body := `{"code":"c","codeVerifier":"v","redirectUri":"https://x/cb","connToken":"` + testConnToken(t, "sub-1") + `"}`

	var limited bool
	for i := 0; i < spotifyBurst*3; i++ {
		if postJSON(h, body).Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("expected the limiter to reject a sustained flood")
	}
}
