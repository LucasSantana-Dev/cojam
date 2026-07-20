package supauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
)

// refetchCooldown bounds how often an unknown kid can trigger a live JWKS
// fetch: without it, unauthenticated connection attempts carrying random kids
// would make this server hammer the Supabase JWKS endpoint at attempt rate.
const refetchCooldown = 30 * time.Second

// Validator validates Supabase access tokens against the project's current
// signing keys. New Supabase projects sign access tokens asymmetrically
// (ECC P-256 / ES256) and publish the public keys as JWKS at
// {SUPABASE_URL}/auth/v1/.well-known/jwks.json; projects migrated from the
// legacy shared secret can still receive HS256 tokens, which are verified
// against legacySecret when provided.
type Validator struct {
	jwksURL string
	issuer  string
	legacy  []byte

	mu        sync.Mutex
	keys      map[string]any // kid -> *ecdsa.PublicKey or *rsa.PublicKey
	lastFetch time.Time
}

// NewValidator builds a Validator for a Supabase project. supabaseURL is the
// project URL (https://<ref>.supabase.co); when empty, only legacy HS256
// tokens can validate. Non-https URLs are refused: key material must never
// travel over plaintext. legacySecret is the legacy JWT secret from the
// dashboard (Settings -> JWT Keys -> Legacy JWT Secret); pass nil to reject
// HS256 tokens entirely.
func NewValidator(supabaseURL string, legacySecret []byte) *Validator {
	v := &Validator{legacy: legacySecret, keys: map[string]any{}}
	if supabaseURL != "" && strings.HasPrefix(supabaseURL, "https://") {
		base := strings.TrimRight(supabaseURL, "/")
		v.jwksURL = base + "/auth/v1/.well-known/jwks.json"
		v.issuer = base + "/auth/v1"
	}
	return v
}

// Validate parses and verifies a Supabase access token and returns the user
// id (sub claim). The signing algorithm selects the path: HS256 uses the
// legacy shared secret; ES256/RS256 use the project's JWKS. As with Validate,
// only aud="authenticated" is accepted.
func (v *Validator) Validate(token string) (string, error) {
	if token == "" {
		return "", errors.New("token cannot be empty")
	}

	unverified, _, err := jwt.NewParser().ParseUnverified(token, &jwt.MapClaims{})
	if err != nil {
		return "", fmt.Errorf("failed to parse token: %w", err)
	}
	alg, _ := unverified.Header["alg"].(string)

	switch alg {
	case "HS256":
		if len(v.legacy) == 0 {
			return "", errors.New("HS256 token but no legacy secret configured")
		}
		return Validate(v.legacy, token)
	case "ES256", "RS256":
		if v.jwksURL == "" {
			return "", fmt.Errorf("%s token but no Supabase URL configured for JWKS", alg)
		}
		return v.validateAsymmetric(token)
	default:
		return "", fmt.Errorf("unexpected signing method: %s", alg)
	}
}

func (v *Validator) validateAsymmetric(token string) (string, error) {
	var kidNotFound bool
	parsedToken, err := jwt.Parse(token, func(tok *jwt.Token) (interface{}, error) {
		kid, _ := tok.Header["kid"].(string)
		key, ok := v.lookupKey(kid)
		if !ok {
			// Unknown kid: the project may have rotated keys. Refetch (bounded
			// by refetchCooldown) and retry.
			if err := v.refetchJWKS(); err != nil {
				return nil, fmt.Errorf("jwks fetch: %w", err)
			}
			key, ok = v.lookupKey(kid)
			if !ok {
				kidNotFound = true
				return nil, fmt.Errorf("no JWKS key for kid %q", kid)
			}
		}
		switch tok.Method.(type) {
		case *jwt.SigningMethodECDSA:
			if _, ok := key.(*ecdsa.PublicKey); !ok {
				return nil, fmt.Errorf("key type mismatch for %v", tok.Method)
			}
		case *jwt.SigningMethodRSA:
			if _, ok := key.(*rsa.PublicKey); !ok {
				return nil, fmt.Errorf("key type mismatch for %v", tok.Method)
			}
		default:
			return nil, fmt.Errorf("unexpected signing method: %v", tok.Method)
		}
		return key, nil
	}, jwt.WithExpirationRequired())
	if err != nil {
		if kidNotFound {
			return "", err
		}
		return "", fmt.Errorf("failed to parse token: %w", err)
	}
	if !parsedToken.Valid {
		return "", errors.New("token is invalid")
	}
	claims, ok := parsedToken.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("failed to extract claims")
	}
	if v.issuer != "" {
		if iss, _ := claims["iss"].(string); iss != v.issuer {
			return "", fmt.Errorf("unexpected issuer: %q", iss)
		}
	}
	return subjectFromClaims(claims)
}

// subjectFromClaims enforces the audience rule and extracts the user id,
// shared by the HS256 and JWKS paths.
func subjectFromClaims(claims jwt.MapClaims) (string, error) {
	aud, _ := claims["aud"].(string)
	if aud != "authenticated" {
		return "", fmt.Errorf("unexpected audience: %q", aud)
	}
	sub, ok := claims["sub"].(string)
	if !ok || sub == "" {
		return "", errors.New("missing or invalid sub claim")
	}
	return sub, nil
}

func (v *Validator) lookupKey(kid string) (any, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	key, ok := v.keys[kid]
	return key, ok
}

type jwkSet struct {
	Keys []struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

// refetchJWKS fetches the JWKS document unless a fetch happened within
// refetchCooldown; concurrent callers within the window share the outcome of
// the previous fetch instead of each hitting the network.
func (v *Validator) refetchJWKS() error {
	v.mu.Lock()
	if time.Since(v.lastFetch) < refetchCooldown {
		v.mu.Unlock()
		return nil
	}
	v.lastFetch = time.Now()
	v.mu.Unlock()
	return v.fetchJWKS()
}

func (v *Validator) fetchJWKS() error {
	req, err := http.NewRequest(http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	var set jwkSet
	if err := httpx.DoJSON(req, &set); err != nil {
		return err
	}

	keys := map[string]any{}
	for _, k := range set.Keys {
		if k.Kid == "" {
			continue
		}
		switch k.Kty {
		case "EC":
			if k.Crv != "P-256" {
				continue
			}
			x, err1 := base64.RawURLEncoding.DecodeString(k.X)
			y, err2 := base64.RawURLEncoding.DecodeString(k.Y)
			if err1 != nil || err2 != nil {
				continue
			}
			keys[k.Kid] = &ecdsa.PublicKey{
				Curve: elliptic.P256(),
				X:     new(big.Int).SetBytes(x),
				Y:     new(big.Int).SetBytes(y),
			}
		case "RSA":
			n, err1 := base64.RawURLEncoding.DecodeString(k.N)
			eBytes, err2 := base64.RawURLEncoding.DecodeString(k.E)
			if err1 != nil || err2 != nil {
				continue
			}
			e := 0
			for _, b := range eBytes {
				e = e<<8 | int(b)
			}
			keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: e}
		}
	}

	// An empty or unparseable document (transient upstream oddity) must not
	// wipe the known-good keys; keep serving the previous set.
	if len(keys) == 0 {
		return errors.New("jwks document contained no usable keys")
	}

	v.mu.Lock()
	v.keys = keys
	v.mu.Unlock()
	return nil
}
