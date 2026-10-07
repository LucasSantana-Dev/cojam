package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/rebind"
)

const testRoomAuthSecret = "test-room-auth-secret"

func doConnectionToken(t *testing.T, url string, enabled bool) (int, map[string]string) {
	t.Helper()
	return doConnectionTokenWithBurns(t, url, enabled, nil)
}

func doConnectionTokenWithBurns(t *testing.T, url string, enabled bool, burns rebind.BurnList) (int, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	connectionTokenHandler(enabled, testRoomAuthSecret, burns, newCallerLimiter(1000, time.Second), discardLogger()).ServeHTTP(rec, req)
	var body map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&body)
	return rec.Code, body
}

func TestConnectionTokenDisabledReturns501(t *testing.T) {
	code, _ := doConnectionToken(t, "/api/connection-token", false)
	if code != http.StatusNotImplemented {
		t.Errorf("Expected 501, got %d", code)
	}
}

func TestConnectionTokenMintsFreshIdentity(t *testing.T) {
	code, body := doConnectionToken(t, "/api/connection-token", true)
	if code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", code)
	}
	if body["userId"] == "" || body["token"] == "" {
		t.Fatalf("Expected userId and token in response, got %v", body)
	}
	// The minted token must validate for the returned userId.
	sub, err := connauth.Validate([]byte(testRoomAuthSecret), body["token"])
	if err != nil {
		t.Fatalf("Returned token does not validate: %v", err)
	}
	if sub != body["userId"] {
		t.Errorf("Token sub %q does not match returned userId %q", sub, body["userId"])
	}
}

func TestConnectionTokenHonorsUserIdWithValidProof(t *testing.T) {
	// Simulate a returning client: it holds a previous token for its userId.
	prev, err := connauth.Mint([]byte(testRoomAuthSecret), "returning-user", 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	code, body := doConnectionToken(t, "/api/connection-token?userId=returning-user&token="+prev, true)
	if code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", code)
	}
	if body["userId"] != "returning-user" {
		t.Errorf("Expected identity continuity, got userId %q", body["userId"])
	}
}

func TestConnectionTokenHonorsUserIdWithExpiredProofInGrace(t *testing.T) {
	prev, err := connauth.Mint([]byte(testRoomAuthSecret), "returning-user", -1*time.Hour)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	_, body := doConnectionToken(t, "/api/connection-token?userId=returning-user&token="+prev, true)
	if body["userId"] != "returning-user" {
		t.Errorf("Expected identity continuity within grace, got userId %q", body["userId"])
	}
}

func TestConnectionTokenIgnoresUserIdWithoutProof(t *testing.T) {
	// The spoof case: attacker knows a victim's userID (e.g. from presence) but
	// has no token for it. They must NOT get a token for that userID.
	_, body := doConnectionToken(t, "/api/connection-token?userId=victim-host", true)
	if body["userId"] == "victim-host" {
		t.Error("userId honored without proof: identity spoofing possible")
	}
	if body["userId"] == "" {
		t.Error("Expected a fresh identity to be minted")
	}
}

func TestConnectionTokenIgnoresUserIdWithWrongSubProof(t *testing.T) {
	// Proof token belongs to someone else.
	prev, err := connauth.Mint([]byte(testRoomAuthSecret), "attacker", 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	_, body := doConnectionToken(t, "/api/connection-token?userId=victim-host&token="+prev, true)
	if body["userId"] == "victim-host" {
		t.Error("userId honored with mismatched proof: identity spoofing possible")
	}
}

func TestConnectionTokenIgnoresUserIdWithBadSignatureProof(t *testing.T) {
	prev, err := connauth.Mint([]byte("wrong-secret"), "victim-host", 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	_, body := doConnectionToken(t, "/api/connection-token?userId=victim-host&token="+prev, true)
	if body["userId"] == "victim-host" {
		t.Error("userId honored with bad-signature proof: identity spoofing possible")
	}
}

// #172 burn: a sub consumed by a room.rebind upgrade is dead. Refresh for it
// is rejected the same way as a forged proof: the userId param is ignored and
// a fresh identity is minted instead.
func TestConnectionTokenRejectsConsumedSubRefresh(t *testing.T) {
	burns := rebind.NewMemory()
	claimed, err := burns.Claim(context.Background(), "consumed-sub")
	if err != nil || !claimed {
		t.Fatalf("seed claim: claimed=%v err=%v", claimed, err)
	}
	prev, err := connauth.Mint([]byte(testRoomAuthSecret), "consumed-sub", 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	code, body := doConnectionTokenWithBurns(t, "/api/connection-token?userId=consumed-sub&token="+prev, true, burns)
	if code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", code)
	}
	if body["userId"] == "consumed-sub" {
		t.Error("consumed sub reissued: the burn must kill identity continuity")
	}
	if body["userId"] == "" {
		t.Error("Expected a fresh identity to be minted")
	}
}

// An unconsumed sub with valid proof keeps identity continuity through the
// burn gate.
func TestConnectionTokenHonorsUnconsumedSub(t *testing.T) {
	burns := rebind.NewMemory()
	prev, err := connauth.Mint([]byte(testRoomAuthSecret), "live-sub", 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	_, body := doConnectionTokenWithBurns(t, "/api/connection-token?userId=live-sub&token="+prev, true, burns)
	if body["userId"] != "live-sub" {
		t.Errorf("Expected identity continuity for an unconsumed sub, got userId %q", body["userId"])
	}
}

func discardLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

// mintPrev returns a valid previous connection token for userID.
func mintPrev(t *testing.T, userID string) string {
	t.Helper()
	prev, err := connauth.Mint([]byte(testRoomAuthSecret), userID, 24*time.Hour)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	return prev
}

func serveToken(t *testing.T, req *http.Request, limiter *callerLimiter, logger *slog.Logger) (int, map[string]string) {
	t.Helper()
	rec := httptest.NewRecorder()
	connectionTokenHandler(true, testRoomAuthSecret, nil, limiter, logger).ServeHTTP(rec, req)
	var body map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&body)
	return rec.Code, body
}

// The refresh proof travels in a POST body or the Authorization header, so it
// never lands in a URL (and so never in access logs or proxy logs).
func TestConnectionToken_PostProofKeepsIdentity(t *testing.T) {
	prev := mintPrev(t, "returning-user")

	jsonBody, _ := json.Marshal(map[string]string{"userId": "returning-user", "token": prev})
	jsonReq := httptest.NewRequest(http.MethodPost, "/api/connection-token", bytes.NewReader(jsonBody))
	jsonReq.Header.Set("Content-Type", "application/json")

	form := url.Values{"userId": {"returning-user"}, "token": {prev}}
	formReq := httptest.NewRequest(http.MethodPost, "/api/connection-token", strings.NewReader(form.Encode()))
	formReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	headerReq := httptest.NewRequest(http.MethodPost, "/api/connection-token", strings.NewReader(url.Values{"userId": {"returning-user"}}.Encode()))
	headerReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	headerReq.Header.Set("Authorization", "Bearer "+prev)

	for name, req := range map[string]*http.Request{"json": jsonReq, "form": formReq, "header": headerReq} {
		code, body := serveToken(t, req, newCallerLimiter(100, time.Second), discardLogger())
		if code != http.StatusOK || body["userId"] != "returning-user" {
			t.Fatalf("%s: got %d %v, want 200 with the kept identity", name, code, body)
		}
	}
}

// A POST without proof still mints a fresh identity (never an error).
func TestConnectionToken_PostWithoutProofMintsFresh(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/connection-token", strings.NewReader(url.Values{"userId": {"someone-else"}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	code, body := serveToken(t, req, newCallerLimiter(100, time.Second), discardLogger())
	if code != http.StatusOK || body["userId"] == "" || body["userId"] == "someone-else" {
		t.Fatalf("got %d %v, want 200 with a fresh identity", code, body)
	}
}

// The legacy GET form keeps working for one release, with a deprecation log
// line that never contains the proof.
func TestConnectionToken_QueryProofDeprecatedButHonored(t *testing.T) {
	prev := mintPrev(t, "returning-user")
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	req := httptest.NewRequest(http.MethodGet, "/api/connection-token?userId=returning-user&token="+url.QueryEscape(prev), nil)
	code, body := serveToken(t, req, newCallerLimiter(100, time.Second), logger)
	if code != http.StatusOK || body["userId"] != "returning-user" {
		t.Fatalf("got %d %v, want the kept identity", code, body)
	}
	if !strings.Contains(logs.String(), "connection_token_query_deprecated") {
		t.Fatalf("missing deprecation log line: %q", logs.String())
	}
	if strings.Contains(logs.String(), prev) || strings.Contains(logs.String(), "returning-user") {
		t.Fatalf("deprecation log must not carry the proof or identity: %q", logs.String())
	}
}

// Minting is rate-limited per client IP.
func TestConnectionToken_RateLimitedPerIP(t *testing.T) {
	limiter := newCallerLimiter(2, time.Hour)
	call := func(remote string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/connection-token", nil)
		req.RemoteAddr = remote
		code, _ := serveToken(t, req, limiter, discardLogger())
		return code
	}
	for i := 0; i < 2; i++ {
		if code := call("198.51.100.7:1000"); code != http.StatusOK {
			t.Fatalf("request %d within burst: %d", i+1, code)
		}
	}
	if code := call("198.51.100.7:2000"); code != http.StatusTooManyRequests {
		t.Fatalf("over budget: got %d, want 429", code)
	}
	if code := call("198.51.100.8:1000"); code != http.StatusOK {
		t.Fatalf("another IP: got %d, want 200", code)
	}
}
