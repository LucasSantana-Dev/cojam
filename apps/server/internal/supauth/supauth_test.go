package supauth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var testSecret = []byte("test-supabase-jwt-secret")

func sign(t *testing.T, method jwt.SigningMethod, secret []byte, claims jwt.MapClaims) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(method, claims).SignedString(secret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return tok
}

func validClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"sub":  "0f8b8f2a-0000-4000-8000-abcdefabcdef",
		"aud":  "authenticated",
		"role": "authenticated",
		"iat":  time.Now().Unix(),
		"exp":  time.Now().Add(time.Hour).Unix(),
	}
}

func TestValidate_ValidToken(t *testing.T) {
	sub, err := Validate(testSecret, sign(t, jwt.SigningMethodHS256, testSecret, validClaims()))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if sub != "0f8b8f2a-0000-4000-8000-abcdefabcdef" {
		t.Errorf("sub = %q, want the token subject", sub)
	}
}

func TestValidate_ExpiredToken(t *testing.T) {
	claims := validClaims()
	claims["exp"] = time.Now().Add(-time.Minute).Unix()
	if _, err := Validate(testSecret, sign(t, jwt.SigningMethodHS256, testSecret, claims)); err == nil {
		t.Fatal("expired token must be rejected")
	}
}

func TestValidate_WrongSecret(t *testing.T) {
	if _, err := Validate(testSecret, sign(t, jwt.SigningMethodHS256, []byte("other-secret"), validClaims())); err == nil {
		t.Fatal("token signed with a different secret must be rejected")
	}
}

func TestValidate_AnonAudienceRejected(t *testing.T) {
	claims := validClaims()
	claims["aud"] = "anon"
	if _, err := Validate(testSecret, sign(t, jwt.SigningMethodHS256, testSecret, claims)); err == nil {
		t.Fatal("aud=anon must be rejected (only authenticated users)")
	}
}

func TestValidate_MissingAudienceRejected(t *testing.T) {
	claims := validClaims()
	delete(claims, "aud")
	if _, err := Validate(testSecret, sign(t, jwt.SigningMethodHS256, testSecret, claims)); err == nil {
		t.Fatal("missing aud must be rejected")
	}
}

func TestValidate_NonHS256Rejected(t *testing.T) {
	if _, err := Validate(testSecret, sign(t, jwt.SigningMethodHS384, testSecret, validClaims())); err == nil {
		t.Fatal("non-HS256 algorithms must be rejected")
	}
}

func TestValidate_EmptyInputs(t *testing.T) {
	if _, err := Validate(nil, "x"); err == nil {
		t.Fatal("empty secret must error")
	}
	if _, err := Validate(testSecret, ""); err == nil {
		t.Fatal("empty token must error")
	}
}
