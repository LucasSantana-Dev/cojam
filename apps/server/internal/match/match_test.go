package match

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestNewCachedMatcher_HitDoesNotReinvoke(t *testing.T) {
	callCount := 0
	inner := func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		callCount++
		return &queue.SourceRef{VideoID: "abc123", Confidence: 0.9}, nil
	}

	hitCount := 0
	missCount := 0
	onEvent := func(hit bool) {
		if hit {
			hitCount++
		} else {
			missCount++
		}
	}

	cached := NewCachedMatcher(inner, onEvent)
	ctx := context.Background()

	// First call: miss, calls inner
	result1, err := cached(ctx, "Song", "Artist", "ISRC123")
	if err != nil {
		t.Fatalf("first call failed: %v", err)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times, want 1", callCount)
	}
	if result1.VideoID != "abc123" {
		t.Errorf("got VideoID %q, want abc123", result1.VideoID)
	}
	if missCount != 1 || hitCount != 0 {
		t.Errorf("after miss: hits=%d misses=%d, want 0 hits 1 miss", hitCount, missCount)
	}

	// Second call: hit, does not call inner
	result2, err := cached(ctx, "Song", "Artist", "ISRC123")
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times after cache hit, want 1", callCount)
	}
	if result2.VideoID != "abc123" {
		t.Errorf("got VideoID %q, want abc123", result2.VideoID)
	}
	if missCount != 1 || hitCount != 1 {
		t.Errorf("after hit: hits=%d misses=%d, want 1 hit 1 miss", hitCount, missCount)
	}
}

func TestNewCachedMatcher_ConcurrentAccess(t *testing.T) {
	callCount := int64(0)
	inner := func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		atomic.AddInt64(&callCount, 1)
		return &queue.SourceRef{VideoID: "vid123", Confidence: 0.85}, nil
	}

	cached := NewCachedMatcher(inner, func(hit bool) {})
	ctx := context.Background()

	var wg sync.WaitGroup
	results := make(map[int]*queue.SourceRef)
	var mu sync.Mutex

	// Fire 10 concurrent goroutines with the same key
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			result, err := cached(ctx, "Same", "Track", "")
			if err != nil {
				t.Errorf("goroutine %d: %v", idx, err)
				return
			}
			mu.Lock()
			results[idx] = result
			mu.Unlock()
		}(i)
	}

	wg.Wait()

	// All should return the same result
	for i := 0; i < 10; i++ {
		if results[i] == nil {
			t.Errorf("result[%d] is nil", i)
			continue
		}
		if results[i].VideoID != "vid123" {
			t.Errorf("result[%d].VideoID = %q, want vid123", i, results[i].VideoID)
		}
	}

	// Inner should have been called only once (or a few times if the lock
	// permits concurrent entries, but definitely not 10 times)
	if callCount > 2 {
		t.Errorf("inner called %d times, want <= 2 (some concurrency is ok)", callCount)
	}
}

func TestNewCachedMatcher_MissCachesNilResults(t *testing.T) {
	callCount := 0
	inner := func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		callCount++
		return nil, nil // No match found
	}

	hitCount := 0
	missCount := 0
	onEvent := func(hit bool) {
		if hit {
			hitCount++
		} else {
			missCount++
		}
	}

	cached := NewCachedMatcher(inner, onEvent)
	ctx := context.Background()

	// First call: miss
	result1, err := cached(ctx, "Unknown", "Artist", "")
	if err != nil {
		t.Fatalf("first call failed: %v", err)
	}
	if result1 != nil {
		t.Errorf("expected nil result, got %v", result1)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times, want 1", callCount)
	}
	if missCount != 1 {
		t.Errorf("missed %d times, want 1", missCount)
	}

	// Second call: should hit the cache (cached nil result)
	result2, err := cached(ctx, "Unknown", "Artist", "")
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}
	if result2 != nil {
		t.Errorf("expected nil result on cache hit, got %v", result2)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times after cache hit on nil, want 1", callCount)
	}
	if hitCount != 1 || missCount != 1 {
		t.Errorf("after cache hit on nil: hits=%d misses=%d, want 1 hit 1 miss", hitCount, missCount)
	}
}

func TestCalculateConfidence(t *testing.T) {
	tests := []struct {
		name      string
		query     string
		title     string
		expected  float64
		tolerance float64
	}{
		{
			name:      "perfect match",
			query:     "hello world",
			title:     "hello world song",
			expected:  1.0,
			tolerance: 0.01,
		},
		{
			name:      "partial match",
			query:     "hello world test",
			title:     "hello song",
			expected:  0.33,
			tolerance: 0.02,
		},
		{
			name:      "no match",
			query:     "hello world",
			title:     "goodbye stranger",
			expected:  0.0,
			tolerance: 0.01,
		},
		{
			name:      "case insensitive",
			query:     "Hello World",
			title:     "hello world song",
			expected:  1.0,
			tolerance: 0.01,
		},
		{
			name:      "single token match",
			query:     "test",
			title:     "test song",
			expected:  1.0,
			tolerance: 0.01,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			queryTokens := strings.Fields(strings.ToLower(tt.query))
			titleTokens := strings.Fields(strings.ToLower(tt.title))
			result := calculateConfidence(queryTokens, titleTokens)

			if diff := result - tt.expected; diff < -tt.tolerance || diff > tt.tolerance {
				t.Errorf("expected %.2f, got %.2f (diff: %.4f)", tt.expected, result, diff)
			}
		})
	}
}

// Spotify matcher tests below

func TestResolveSpotify_ErrNotConfigured(t *testing.T) {
	// Save old env state
	oldID := spotifyClientID
	oldSecret := spotifyClientSecret
	defer func() {
		spotifyClientID = oldID
		spotifyClientSecret = oldSecret
	}()

	// Unset credentials
	spotifyClientID = ""
	spotifyClientSecret = ""

	ref, err := ResolveSpotify(context.Background(), "Title", "Artist", "")
	if err != ErrNotConfigured {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
	if ref != nil {
		t.Errorf("expected nil ref, got %v", ref)
	}
}

func TestResolveSpotify_NoResults(t *testing.T) {
	// This test verifies that empty search results return (nil, nil)
	// Placeholder: will implement after stubbing the HTTP layer
	t.Skip("TODO: implement with httptest stubs")
}

func TestResolveSpotify_ConfidenceBelowThreshold(t *testing.T) {
	// This test verifies that results below MinConfidence return (nil, nil)
	t.Skip("TODO: implement with httptest stubs")
}
