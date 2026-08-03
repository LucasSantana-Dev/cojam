package rebind

import (
	"context"
	"testing"
)

// The burn list is the single-use guarantee for rebind proofs (#172): the
// first claim wins atomically and every later claim reports claimed=false.
func TestMemoryClaimFirstWins(t *testing.T) {
	b := NewMemory()
	ctx := context.Background()

	claimed, err := b.Claim(ctx, "sub-1")
	if err != nil || !claimed {
		t.Fatalf("first claim: claimed=%v err=%v, want claimed=true", claimed, err)
	}
	claimed, err = b.Claim(ctx, "sub-1")
	if err != nil || claimed {
		t.Fatalf("second claim of the same sub: claimed=%v err=%v, want claimed=false", claimed, err)
	}
	claimed, err = b.Claim(ctx, "sub-2")
	if err != nil || !claimed {
		t.Fatalf("claim of a different sub: claimed=%v err=%v, want claimed=true", claimed, err)
	}
}

func TestMemoryConsumed(t *testing.T) {
	b := NewMemory()
	ctx := context.Background()

	consumed, err := b.Consumed(ctx, "sub-1")
	if err != nil || consumed {
		t.Fatalf("unclaimed sub: consumed=%v err=%v, want false", consumed, err)
	}
	if _, err := b.Claim(ctx, "sub-1"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	consumed, err = b.Consumed(ctx, "sub-1")
	if err != nil || !consumed {
		t.Fatalf("claimed sub: consumed=%v err=%v, want true", consumed, err)
	}
}
