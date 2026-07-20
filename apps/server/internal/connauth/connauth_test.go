package connauth

import (
	"encoding/base64"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestMintAndValidateRoundTrip(t *testing.T) {
	secret := []byte("test-secret-key")
	sub := "user-12345"
	ttl := 1 * time.Hour

	// Mint a token
	token, err := Mint(secret, sub, ttl)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}
	if token == "" {
		t.Fatal("Mint returned empty token")
	}

	// Validate the token
	validatedSub, err := Validate(secret, token)
	if err != nil {
		t.Fatalf("Validate failed: %v", err)
	}
	if validatedSub != sub {
		t.Errorf("Expected sub %q, got %q", sub, validatedSub)
	}
}

func TestValidateRejectsTamperedSignature(t *testing.T) {
	secret := []byte("test-secret-key")
	sub := "user-12345"
	ttl := 1 * time.Hour

	token, err := Mint(secret, sub, ttl)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}

	// Tamper with the payload part (middle section between first and second dot)
	parts := base64.RawURLEncoding.EncodeToString([]byte("tampered"))
	if i := findNthDot(token, 1); i > 0 && i < len(token)-1 {
		if j := findNthDot(token, 2); j > i {
			tamperedToken := token[:i+1] + parts + token[j:]
			_, err = Validate(secret, tamperedToken)
			if err == nil {
				t.Fatal("Validate should reject tampered payload but did not")
				return
			}
		}
	}

	// Fallback: tamper with the FIRST signature char. The final base64 char of
	// a 32-byte signature carries 2 ignored padding bits, so replacing it with
	// a char that differs only there (e.g. U/V/W -> X) leaves the decoded
	// signature byte-identical and the "tampered" token valid: ~5% flake.
	// Every bit of the first char is significant, so the swap always changes
	// the signature. Replacement is still guaranteed different from the
	// original char.
	sigStart := findNthDot(token, 2) + 1
	replacement := byte('X')
	if token[sigStart] == replacement {
		replacement = 'Y'
	}
	tamperedToken := token[:sigStart] + string(replacement) + token[sigStart+1:]
	_, err = Validate(secret, tamperedToken)
	if err == nil {
		t.Fatal("Validate should reject tampered signature but did not")
	}
}

// findNthDot returns the index of the nth dot in s, or -1 if not found.
func findNthDot(s string, n int) int {
	count := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			count++
			if count == n {
				return i
			}
		}
	}
	return -1
}

func TestValidateRejectsWrongSecret(t *testing.T) {
	secret := []byte("test-secret-key")
	wrongSecret := []byte("wrong-secret-key")
	sub := "user-12345"
	ttl := 1 * time.Hour

	token, err := Mint(secret, sub, ttl)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}

	_, err = Validate(wrongSecret, token)
	if err == nil {
		t.Fatal("Validate should reject token signed with different secret but did not")
	}
}

func TestValidateRejectsExpiredToken(t *testing.T) {
	secret := []byte("test-secret-key")
	sub := "user-12345"
	ttl := -1 * time.Second // Expired immediately

	token, err := Mint(secret, sub, ttl)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}

	// Wait a bit to ensure token is expired
	time.Sleep(10 * time.Millisecond)

	_, err = Validate(secret, token)
	if err == nil {
		t.Fatal("Validate should reject expired token but did not")
	}
}

func TestValidateRejectsMalformedToken(t *testing.T) {
	secret := []byte("test-secret-key")

	_, err := Validate(secret, "not-a-valid-jwt")
	if err == nil {
		t.Fatal("Validate should reject malformed token but did not")
	}
}

func TestValidateRejectsEmptyToken(t *testing.T) {
	secret := []byte("test-secret-key")

	_, err := Validate(secret, "")
	if err == nil {
		t.Fatal("Validate should reject empty token but did not")
	}
}

func TestValidateRejectsWrongAlgorithm(t *testing.T) {
	// Create a token with "none" algorithm
	// This simulates an attacker bypassing signature verification
	token := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"sub": "user-12345",
		"exp": time.Now().Add(1 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
	})
	noneToken, err := token.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("Failed to create none-algorithm token: %v", err)
	}

	secret := []byte("test-secret-key")
	_, err = Validate(secret, noneToken)
	if err == nil {
		t.Fatal("Validate should reject none-algorithm token when expecting HS256 but did not")
	}
}

func TestMintedTokenHasCorrectClaims(t *testing.T) {
	secret := []byte("test-secret-key")
	sub := "user-12345"
	ttl := 1 * time.Hour

	token, err := Mint(secret, sub, ttl)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}

	// Parse the token to check its claims
	parsedToken, err := jwt.Parse(token, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			t.Errorf("Expected HS256, got %v", token.Method)
		}
		return secret, nil
	})
	if err != nil {
		t.Fatalf("Failed to parse token: %v", err)
	}

	claims, ok := parsedToken.Claims.(jwt.MapClaims)
	if !ok {
		t.Fatal("Failed to extract claims")
	}

	if claimSub, ok := claims["sub"].(string); !ok || claimSub != sub {
		t.Errorf("Expected sub claim %q, got %q", sub, claimSub)
	}

	if _, ok := claims["exp"]; !ok {
		t.Error("Missing exp claim")
	}

	if _, ok := claims["iat"]; !ok {
		t.Error("Missing iat claim")
	}
}

func TestNewSubGeneratesUniqueIDs(t *testing.T) {
	sub1 := NewSub()
	sub2 := NewSub()

	if sub1 == "" || sub2 == "" {
		t.Fatal("NewSub returned empty string")
	}

	if sub1 == sub2 {
		t.Errorf("NewSub generated duplicate IDs: %q == %q", sub1, sub2)
	}

	// Verify it's a valid string (base64url safe)
	if _, err := base64.RawURLEncoding.DecodeString(sub1); err != nil {
		t.Errorf("sub1 is not valid base64url: %v", err)
	}
	if _, err := base64.RawURLEncoding.DecodeString(sub2); err != nil {
		t.Errorf("sub2 is not valid base64url: %v", err)
	}
}

func TestMintWithProvidedSub(t *testing.T) {
	secret := []byte("test-secret-key")
	sub := "my-custom-sub"
	ttl := 1 * time.Hour

	token, err := Mint(secret, sub, ttl)
	if err != nil {
		t.Fatalf("Mint failed: %v", err)
	}

	validatedSub, err := Validate(secret, token)
	if err != nil {
		t.Fatalf("Validate failed: %v", err)
	}

	if validatedSub != sub {
		t.Errorf("Expected sub %q, got %q", sub, validatedSub)
	}
}
