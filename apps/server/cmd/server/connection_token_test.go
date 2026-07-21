package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
)

const testRoomAuthSecret = "test-room-auth-secret"

func doConnectionToken(t *testing.T, url string, enabled bool) (int, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	connectionTokenHandler(enabled, testRoomAuthSecret).ServeHTTP(rec, req)
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
