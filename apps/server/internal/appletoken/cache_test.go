package appletoken

import (
	"testing"
	"time"
)

// TestBuildToken_CachesUntilTTL proves the token is signed once and reused
// inside the TTL window, and re-signed only once the cached token enters its
// final cacheRefreshMargin. The clock is stubbed via the package now var.
func TestBuildToken_CachesUntilTTL(t *testing.T) {
	path, _ := writePKCS8Key(t)
	t.Setenv("APPLE_TEAM_ID", "TEAM123456")
	t.Setenv("APPLE_KEY_ID", "KEY1234567")
	t.Setenv("APPLE_PRIVATE_KEY_P8", path)

	base := time.Now()
	current := base
	restoreNow := now
	now = func() time.Time { return current }
	t.Cleanup(func() {
		now = restoreNow
		cache.mu.Lock()
		cache.key, cache.token = "", ""
		cache.expiry = time.Time{}
		cache.mu.Unlock()
	})

	first, err := BuildToken()
	if err != nil {
		t.Fatalf("first BuildToken: %v", err)
	}

	// Inside the TTL window: same token, no re-sign.
	current = base.Add(6 * time.Hour)
	second, err := BuildToken()
	if err != nil {
		t.Fatalf("second BuildToken: %v", err)
	}
	if second != first {
		t.Fatal("cached token must be reused inside the TTL window")
	}

	// Within the final margin: re-sign (a near-expired token is never served).
	current = base.Add(tokenTTL - cacheRefreshMargin/2)
	third, err := BuildToken()
	if err != nil {
		t.Fatalf("third BuildToken: %v", err)
	}
	if third == first {
		t.Fatal("token inside its final margin must be re-signed")
	}

	// The re-signed token is itself cached.
	fourth, err := BuildToken()
	if err != nil {
		t.Fatalf("fourth BuildToken: %v", err)
	}
	if fourth != third {
		t.Fatal("re-signed token must also be cached")
	}
}
