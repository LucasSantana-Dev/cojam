// Package spotifytoken holds Spotify refresh tokens server-side, keyed to the
// connauth anonymous sub (#252, docs/specs/252-spotify-server-side-token-exchange.md).
//
// The refresh token is a long-lived credential for a user's Spotify account.
// Before this, it lived in sessionStorage where any script on the page could
// read it; PKCE protects the authorization code in transit, not the tokens it
// produces. Here it never reaches the browser at all.
//
// Records are sealed with AES-GCM so a database dump does not hand over live
// Spotify credentials. The key is separate from DATABASE_URL on purpose: one
// leaking should not imply the other.
package spotifytoken

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound reports that a sub has no stored token, either because it never
// connected or because the record expired.
var ErrNotFound = errors.New("no stored refresh token")

// ErrNoKey reports that sealing was attempted without a configured key.
var ErrNoKey = errors.New("token encryption key not configured")

// Store persists one Spotify refresh token per connauth sub.
type Store interface {
	// Put records (or replaces) the refresh token for sub. Replacing matters:
	// Spotify may rotate the refresh token on use.
	Put(ctx context.Context, sub, refreshToken string, expiresAt time.Time) error
	// Get returns the refresh token for sub, or ErrNotFound.
	Get(ctx context.Context, sub string) (string, error)
	// Delete removes sub's record. Used when Spotify reports invalid_grant,
	// which means the user revoked the grant and retrying can never succeed.
	Delete(ctx context.Context, sub string) error
}

// Sealer encrypts and decrypts stored tokens.
type Sealer struct {
	aead cipher.AEAD
}

// NewSealer builds a Sealer from a 32-byte key. A shorter or absent key is an
// error rather than a silent downgrade: storing an unencrypted refresh token
// is worse than not storing one.
func NewSealer(key []byte) (*Sealer, error) {
	if len(key) != 32 {
		return nil, ErrNoKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{aead: aead}, nil
}

// Seal encrypts plaintext, prefixing the random nonce. The sub is bound in as
// additional data, so a record moved to a different sub fails to open.
func (s *Sealer) Seal(sub, plaintext string) (string, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := s.aead.Seal(nonce, nonce, []byte(plaintext), []byte(sub))
	return base64.RawStdEncoding.EncodeToString(sealed), nil
}

// Open reverses Seal. It fails if the record was written for a different sub.
func (s *Sealer) Open(sub, encoded string) (string, error) {
	raw, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	if len(raw) < s.aead.NonceSize() {
		return "", errors.New("sealed record too short")
	}
	nonce, body := raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():]
	plaintext, err := s.aead.Open(nil, nonce, body, []byte(sub))
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

type record struct {
	sealed    string
	expiresAt time.Time
}

// Memory is an in-memory Store for local dev and for deployments with no
// database. Records do not survive restart, so a user reconnects Spotify after
// a rollover — the same trade-off in-memory rooms already make.
type Memory struct {
	mu      sync.Mutex
	sealer  *Sealer
	records map[string]record
	now     func() time.Time
}

// NewMemory creates an empty in-memory Store.
func NewMemory(sealer *Sealer) *Memory {
	return &Memory{sealer: sealer, records: map[string]record{}, now: time.Now}
}

func (m *Memory) Put(_ context.Context, sub, refreshToken string, expiresAt time.Time) error {
	if m.sealer == nil {
		return ErrNoKey
	}
	sealed, err := m.sealer.Seal(sub, refreshToken)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records[sub] = record{sealed: sealed, expiresAt: expiresAt}
	return nil
}

func (m *Memory) Get(_ context.Context, sub string) (string, error) {
	if m.sealer == nil {
		return "", ErrNoKey
	}
	m.mu.Lock()
	rec, ok := m.records[sub]
	if ok && m.now().After(rec.expiresAt) {
		delete(m.records, sub) // expired records are the same as absent ones
		ok = false
	}
	m.mu.Unlock()

	if !ok {
		return "", ErrNotFound
	}
	return m.sealer.Open(sub, rec.sealed)
}

func (m *Memory) Delete(_ context.Context, sub string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.records, sub)
	return nil
}

// Postgres is a Store backed by the spotify_tokens table, so a connected
// Spotify account survives a server rollover.
type Postgres struct {
	pool   *pgxpool.Pool
	sealer *Sealer
}

// NewPostgres creates a Postgres Store on the given pool.
func NewPostgres(pool *pgxpool.Pool, sealer *Sealer) *Postgres {
	return &Postgres{pool: pool, sealer: sealer}
}

// Put replaces any existing record for sub. Spotify may rotate the refresh
// token on use, so the upsert is the normal path, not an edge case.
func (p *Postgres) Put(ctx context.Context, sub, refreshToken string, expiresAt time.Time) error {
	if p.sealer == nil {
		return ErrNoKey
	}
	sealed, err := p.sealer.Seal(sub, refreshToken)
	if err != nil {
		return err
	}
	_, err = p.pool.Exec(ctx, `
		INSERT INTO spotify_tokens (sub, sealed_token, expires_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (sub) DO UPDATE
		SET sealed_token = EXCLUDED.sealed_token,
		    expires_at   = EXCLUDED.expires_at,
		    updated_at   = now()
	`, sub, sealed, expiresAt)
	if err != nil {
		return fmt.Errorf("failed to store spotify token: %w", err)
	}
	return nil
}

// Get returns sub's refresh token, treating an expired record as absent.
func (p *Postgres) Get(ctx context.Context, sub string) (string, error) {
	if p.sealer == nil {
		return "", ErrNoKey
	}
	var sealed string
	err := p.pool.QueryRow(ctx, `
		SELECT sealed_token FROM spotify_tokens
		WHERE sub = $1 AND expires_at > now()
	`, sub).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("failed to load spotify token: %w", err)
	}
	return p.sealer.Open(sub, sealed)
}

// Delete removes sub's record.
func (p *Postgres) Delete(ctx context.Context, sub string) error {
	if _, err := p.pool.Exec(ctx, `DELETE FROM spotify_tokens WHERE sub = $1`, sub); err != nil {
		return fmt.Errorf("failed to delete spotify token: %w", err)
	}
	return nil
}

// DeleteExpired removes records past their expiry. Called on the same schedule
// as idle-room eviction so abandoned guest sessions do not leave live Spotify
// credentials behind indefinitely.
func (p *Postgres) DeleteExpired(ctx context.Context) (int64, error) {
	tag, err := p.pool.Exec(ctx, `DELETE FROM spotify_tokens WHERE expires_at <= now()`)
	if err != nil {
		return 0, fmt.Errorf("failed to prune spotify tokens: %w", err)
	}
	return tag.RowsAffected(), nil
}
