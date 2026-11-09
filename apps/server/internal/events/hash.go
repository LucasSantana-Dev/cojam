package events

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
)

// hashBytes is how much of the HMAC-SHA256 output is kept: 16 bytes, 32 hex
// characters. Enough that a collision among a year of rooms is negligible,
// short enough that the digest is not mistaken for a full credential.
const hashBytes = 16

// Hasher turns identifiers into stable pseudonyms. The same input and key
// always give the same digest (so a dashboard can count distinct rooms and
// actors), and the digest cannot be reversed or recomputed without the key.
type Hasher struct{ key []byte }

// NewHasher keys a Hasher. An empty key is replaced by a random one, which is
// stable only for this process: the caller logs that (see GenerateKey).
func NewHasher(key []byte) *Hasher {
	if len(key) == 0 {
		key = GenerateKey()
	}
	return &Hasher{key: append([]byte(nil), key...)}
}

// GenerateKey returns 32 random bytes.
func GenerateKey() []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		// crypto/rand does not fail on supported platforms; refusing to run
		// with a guessable key is the only safe answer if it ever does.
		panic("events: crypto/rand unavailable: " + err.Error())
	}
	return k
}

// Room pseudonymises a room id. Room ids are capabilities (spec 245 section
// 2.5), so the clear value must never reach the table.
func (h *Hasher) Room(roomID string) string { return h.sum("room:", roomID) }

// Actor pseudonymises a voter or user identity ("user:<id>" or
// "client:<connection id>"). A separate domain prefix keeps an actor digest
// from ever equalling a room digest of the same string.
func (h *Hasher) Actor(actorID string) string { return h.sum("actor:", actorID) }

func (h *Hasher) sum(domain, id string) string {
	if id == "" {
		return ""
	}
	m := hmac.New(sha256.New, h.key)
	m.Write([]byte(domain))
	m.Write([]byte(id))
	return hex.EncodeToString(m.Sum(nil)[:hashBytes])
}
