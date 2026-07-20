package supauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// jwksStub serves a JWKS document for a generated P-256 key and counts fetches.
type jwksStub struct {
	server *httptest.Server
	priv   *ecdsa.PrivateKey
	kid    string
	hits   atomic.Int32
}

func newJWKSStub(t *testing.T) *jwksStub {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	s := &jwksStub{priv: priv, kid: "test-key-1"}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.hits.Add(1)
		json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]any{{
				"kty": "EC",
				"crv": "P-256",
				"kid": s.kid,
				"use": "sig",
				"alg": "ES256",
				"x":   base64.RawURLEncoding.EncodeToString(priv.PublicKey.X.Bytes()),
				"y":   base64.RawURLEncoding.EncodeToString(priv.PublicKey.Y.Bytes()),
			}},
		})
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *jwksStub) signES256(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = s.kid
	signed, err := tok.SignedString(s.priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// newStubValidator builds a Validator whose JWKS URL points at the stub. The
// Supabase URL shape is faked by trimming the fixed suffix NewValidator adds.
func newStubValidator(s *jwksStub, legacy []byte) *Validator {
	v := NewValidator("", legacy)
	v.jwksURL = s.server.URL
	return v
}

func TestValidator_ES256ValidToken(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, nil)

	sub, err := v.Validate(stub.signES256(t, validClaims()))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if sub != "0f8b8f2a-0000-4000-8000-abcdefabcdef" {
		t.Errorf("sub = %q, want the token subject", sub)
	}
	if stub.hits.Load() != 1 {
		t.Errorf("jwks fetches = %d, want 1 (unknown kid triggers one fetch)", stub.hits.Load())
	}
}

func TestValidator_ES256KeyCached(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, nil)

	if _, err := v.Validate(stub.signES256(t, validClaims())); err != nil {
		t.Fatalf("first Validate: %v", err)
	}
	if _, err := v.Validate(stub.signES256(t, validClaims())); err != nil {
		t.Fatalf("second Validate: %v", err)
	}
	if stub.hits.Load() != 1 {
		t.Errorf("jwks fetches = %d, want 1 (second validation uses cache)", stub.hits.Load())
	}
}

func TestValidator_ES256WrongKey(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, nil)

	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, validClaims())
	tok.Header["kid"] = stub.kid
	signed, err := tok.SignedString(other)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := v.Validate(signed); err == nil {
		t.Fatal("token signed with a different key must be rejected")
	}
}

func TestValidator_ES256UnknownKidRefetchesOnce(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, nil)

	tok := jwt.NewWithClaims(jwt.SigningMethodES256, validClaims())
	tok.Header["kid"] = "no-such-key"
	signed, err := tok.SignedString(stub.priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := v.Validate(signed); err == nil {
		t.Fatal("unknown kid must be rejected after refetch")
	}
	if stub.hits.Load() != 1 {
		t.Errorf("jwks fetches = %d, want exactly 1 refetch", stub.hits.Load())
	}
}

func TestValidator_ES256AnonAudienceRejected(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, nil)

	claims := validClaims()
	claims["aud"] = "anon"
	if _, err := v.Validate(stub.signES256(t, claims)); err == nil {
		t.Fatal("aud=anon must be rejected")
	}
}

func TestValidator_ES256ExpiredRejected(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, nil)

	claims := validClaims()
	claims["exp"] = time.Now().Add(-time.Minute).Unix()
	if _, err := v.Validate(stub.signES256(t, claims)); err == nil {
		t.Fatal("expired token must be rejected")
	}
}

func TestValidator_HS256LegacyFallback(t *testing.T) {
	stub := newJWKSStub(t)
	v := newStubValidator(stub, testSecret)

	sub, err := v.Validate(sign(t, jwt.SigningMethodHS256, testSecret, validClaims()))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if sub == "" {
		t.Error("HS256 token with legacy secret must validate")
	}
	if stub.hits.Load() != 0 {
		t.Errorf("jwks fetches = %d, want 0 (HS256 never touches JWKS)", stub.hits.Load())
	}
}

func TestValidator_HS256RejectedWithoutSecret(t *testing.T) {
	v := NewValidator("https://example.supabase.co", nil)
	if _, err := v.Validate(sign(t, jwt.SigningMethodHS256, testSecret, validClaims())); err == nil {
		t.Fatal("HS256 without a legacy secret must be rejected")
	}
}

func TestValidator_ES256RejectedWithoutURL(t *testing.T) {
	stub := newJWKSStub(t)
	v := NewValidator("", nil)
	if _, err := v.Validate(stub.signES256(t, validClaims())); err == nil {
		t.Fatal("ES256 without a Supabase URL must be rejected")
	}
}

func TestValidator_UnknownAlgRejected(t *testing.T) {
	v := NewValidator("https://example.supabase.co", testSecret)
	if _, err := v.Validate(sign(t, jwt.SigningMethodHS384, testSecret, validClaims())); err == nil {
		t.Fatal("HS384 must be rejected")
	}
}
