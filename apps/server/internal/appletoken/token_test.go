package appletoken

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Apple ships .p8 keys as PKCS#8 ("BEGIN PRIVATE KEY"), not SEC1.
func writePKCS8Key(t *testing.T) (string, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "AuthKey_TEST.p8")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: der}); err != nil {
		t.Fatal(err)
	}
	return path, key
}

func TestBuildToken_PKCS8AppleFormat(t *testing.T) {
	path, key := writePKCS8Key(t)
	t.Setenv("APPLE_TEAM_ID", "TEAM123456")
	t.Setenv("APPLE_KEY_ID", "KEY1234567")
	t.Setenv("APPLE_PRIVATE_KEY_P8", path)

	tok, err := BuildToken()
	if err != nil {
		t.Fatalf("BuildToken with PKCS#8 key (Apple's format): %v", err)
	}

	parsed, err := jwt.Parse(tok, func(tk *jwt.Token) (any, error) {
		if tk.Method.Alg() != "ES256" {
			t.Fatalf("alg = %s, want ES256", tk.Method.Alg())
		}
		return &key.PublicKey, nil
	})
	if err != nil || !parsed.Valid {
		t.Fatalf("token invalid: %v", err)
	}
	if parsed.Header["kid"] != "KEY1234567" {
		t.Fatalf("kid = %v", parsed.Header["kid"])
	}
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["iss"] != "TEAM123456" {
		t.Fatalf("iss = %v", claims["iss"])
	}
	exp := int64(claims["exp"].(float64))
	iat := int64(claims["iat"].(float64))
	if exp-iat > int64((180*24*time.Hour).Seconds()) {
		t.Fatalf("token lifetime %ds exceeds Apple's 180-day max", exp-iat)
	}
}

func TestBuildToken_MissingEnv(t *testing.T) {
	t.Setenv("APPLE_TEAM_ID", "")
	t.Setenv("APPLE_KEY_ID", "")
	t.Setenv("APPLE_PRIVATE_KEY_P8", "")
	if _, err := BuildToken(); err != ErrNotConfigured {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}
