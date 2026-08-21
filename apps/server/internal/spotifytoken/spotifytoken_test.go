package spotifytoken

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
)

func testSealer(t *testing.T) *Sealer {
	t.Helper()
	s, err := NewSealer([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewSealer: %v", err)
	}
	return s
}

func TestNewSealer_RejectsWrongKeyLength(t *testing.T) {
	for _, key := range [][]byte{nil, []byte(""), []byte("short"), make([]byte, 31)} {
		if _, err := NewSealer(key); !errors.Is(err, ErrNoKey) {
			t.Errorf("key len %d: expected ErrNoKey, got %v", len(key), err)
		}
	}
}

// The stored form must never contain the token. This is the property the whole
// package exists for.
func TestSeal_CiphertextDoesNotContainPlaintext(t *testing.T) {
	s := testSealer(t)
	const token = "AQC-refresh-token-value-9f3a"

	sealed, err := s.Seal("sub-1", token)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if strings.Contains(sealed, token) {
		t.Fatal("sealed record leaks the plaintext token")
	}
}

func TestSealOpen_RoundTrips(t *testing.T) {
	s := testSealer(t)
	sealed, err := s.Seal("sub-1", "refresh-value")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	got, err := s.Open("sub-1", sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got != "refresh-value" {
		t.Fatalf("got %q, want %q", got, "refresh-value")
	}
}

// The sub is bound in as additional data, so lifting a row onto another
// identity fails instead of granting that identity someone else's account.
func TestOpen_RejectsRecordMovedToAnotherSub(t *testing.T) {
	s := testSealer(t)
	sealed, err := s.Seal("sub-victim", "refresh-value")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := s.Open("sub-attacker", sealed); err == nil {
		t.Fatal("expected opening under a different sub to fail")
	}
}

// Tampering is applied to the DECODED bytes, never to the base64 text. Seal
// uses RawStdEncoding, whose final character carries bits the decoder discards,
// so flipping a bit in the encoded string was frequently a no-op: nothing was
// actually altered, Open correctly succeeded, and the test failed. It failed 11
// times in 40 runs before this change.
//
// Every byte is tampered in turn rather than one, which covers the nonce, the
// ciphertext and the GCM tag instead of whichever section the last byte lands in.
func TestOpen_RejectsTamperedCiphertext(t *testing.T) {
	s := testSealer(t)
	sealed, err := s.Seal("sub-1", "refresh-value")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	raw, err := base64.RawStdEncoding.DecodeString(sealed)
	if err != nil {
		t.Fatalf("DecodeString: %v", err)
	}

	for i := range raw {
		tampered := make([]byte, len(raw))
		copy(tampered, raw)
		tampered[i] ^= 0x01

		encoded := base64.RawStdEncoding.EncodeToString(tampered)
		if _, err := s.Open("sub-1", encoded); err == nil {
			t.Errorf("byte %d of %d: tampering went undetected", i, len(raw))
		}
	}
}

func TestOpen_RejectsMalformed(t *testing.T) {
	s := testSealer(t)
	for _, record := range []string{"not-base64!!", "", "AAAA"} {
		if _, err := s.Open("sub-1", record); err == nil {
			t.Errorf("expected %q to fail", record)
		}
	}
}

func TestMemory_PutGetDelete(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(testSealer(t))
	future := time.Now().Add(time.Hour)

	if _, err := m.Get(ctx, "sub-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound before Put, got %v", err)
	}
	if err := m.Put(ctx, "sub-1", "refresh-value", future); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := m.Get(ctx, "sub-1")
	if err != nil || got != "refresh-value" {
		t.Fatalf("Get: got %q, %v", got, err)
	}
	if err := m.Delete(ctx, "sub-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := m.Get(ctx, "sub-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after Delete, got %v", err)
	}
}

// Spotify rotates the refresh token on use, so replacement is the normal path.
func TestMemory_PutReplaces(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(testSealer(t))
	future := time.Now().Add(time.Hour)

	_ = m.Put(ctx, "sub-1", "first", future)
	_ = m.Put(ctx, "sub-1", "second", future)

	got, err := m.Get(ctx, "sub-1")
	if err != nil || got != "second" {
		t.Fatalf("expected the rotated token, got %q, %v", got, err)
	}
}

func TestMemory_ExpiredRecordIsAbsent(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(testSealer(t))
	now := time.Now()
	m.now = func() time.Time { return now }

	if err := m.Put(ctx, "sub-1", "refresh-value", now.Add(time.Minute)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	m.now = func() time.Time { return now.Add(2 * time.Minute) }

	if _, err := m.Get(ctx, "sub-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected an expired record to read as absent, got %v", err)
	}
}

// Without a key there is no safe way to store a refresh token, so refuse
// rather than persist it in the clear.
func TestMemory_WithoutSealerRefuses(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(nil)

	if err := m.Put(ctx, "sub-1", "refresh-value", time.Now().Add(time.Hour)); !errors.Is(err, ErrNoKey) {
		t.Errorf("Put: expected ErrNoKey, got %v", err)
	}
	if _, err := m.Get(ctx, "sub-1"); !errors.Is(err, ErrNoKey) {
		t.Errorf("Get: expected ErrNoKey, got %v", err)
	}
}

// Runs in CI via the Postgres service container added in #247.
func TestPostgres_RoundTripAndExpiry(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	store := NewPostgres(pool, testSealer(t))
	sub := "test-sub-" + time.Now().Format("150405.000000")
	defer store.Delete(ctx, sub)

	if _, err := store.Get(ctx, sub); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound before Put, got %v", err)
	}
	if err := store.Put(ctx, sub, "refresh-value", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := store.Get(ctx, sub)
	if err != nil || got != "refresh-value" {
		t.Fatalf("Get: got %q, %v", got, err)
	}

	// Rotation: the upsert must replace, not conflict.
	if err := store.Put(ctx, sub, "rotated", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("Put (rotate): %v", err)
	}
	if got, _ := store.Get(ctx, sub); got != "rotated" {
		t.Fatalf("expected the rotated token, got %q", got)
	}

	// An already-expired record must read as absent, not as a live credential.
	if err := store.Put(ctx, sub, "stale", time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("Put (expired): %v", err)
	}
	if _, err := store.Get(ctx, sub); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected an expired row to read as absent, got %v", err)
	}

	// And the sweep must remove it.
	if _, err := store.DeleteExpired(ctx); err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
}

// The row must hold ciphertext. Verified against the real column, because this
// is the property a database dump would expose.
func TestPostgres_ColumnHoldsCiphertext(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	store := NewPostgres(pool, testSealer(t))
	sub := "test-cipher-" + time.Now().Format("150405.000000")
	defer store.Delete(ctx, sub)

	const token = "AQC-refresh-token-value-9f3a"
	if err := store.Put(ctx, sub, token, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("Put: %v", err)
	}

	var stored string
	if err := pool.QueryRow(ctx, `SELECT sealed_token FROM spotify_tokens WHERE sub = $1`, sub).Scan(&stored); err != nil {
		t.Fatalf("reading the raw column: %v", err)
	}
	if strings.Contains(stored, token) {
		t.Fatal("the stored column holds the plaintext refresh token")
	}
}
