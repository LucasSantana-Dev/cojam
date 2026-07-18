package listenbrainz

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Test FetchEnrichment with a valid ISRC response
func TestFetchEnrichment_ValidISRC(t *testing.T) {
	// Mock server returns a recording by ISRC
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Recording by ISRC returns MBID and metadata
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"isrc": "GBUM71029604",
			"recordings": [
				{
					"id": "3d3d3d00-0000-0000-0000-000000000001",
					"title": "Bohemian Rhapsody",
					"artists": [{"name": "Queen"}]
				}
			]
		}`))
	}))
	defer server.Close()

	// Inject test server URL
	oldBaseURL := baseURL
	baseURL = server.URL
	defer func() { baseURL = oldBaseURL }()

	enrichment, err := FetchEnrichment(context.Background(), "GBUM71029604", "Bohemian Rhapsody", "Queen")
	if err != nil {
		t.Fatalf("FetchEnrichment: %v", err)
	}
	if enrichment == nil {
		t.Fatal("enrichment should not be nil")
	}
	if enrichment.Source != "listenbrainz" {
		t.Fatalf("source = %q, want listenbrainz", enrichment.Source)
	}
	if enrichment.MBID == "" {
		t.Fatal("MBID should not be empty")
	}
}

// Test FetchEnrichment gracefully returns empty when no ISRC match
func TestFetchEnrichment_NoISRCMatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// No recordings found for ISRC
		_, _ = w.Write([]byte(`{"isrc": "FAKE00000000", "recordings": []}`))
	}))
	defer server.Close()

	oldBaseURL := baseURL
	baseURL = server.URL
	defer func() { baseURL = oldBaseURL }()

	enrichment, err := FetchEnrichment(context.Background(), "FAKE00000000", "Unknown", "Artist")
	if err != nil {
		t.Fatalf("FetchEnrichment: %v", err)
	}
	if enrichment == nil {
		t.Fatal("enrichment should not be nil (graceful degradation)")
	}
	if enrichment.Source != "listenbrainz" {
		t.Fatalf("source = %q, want listenbrainz", enrichment.Source)
	}
	// Empty MBID is acceptable
	if enrichment.Tags == nil {
		t.Fatal("Tags should be an empty slice, not nil")
	}
}

// Test FetchEnrichment handles network errors gracefully
func TestFetchEnrichment_NetworkError(t *testing.T) {
	oldBaseURL := baseURL
	baseURL = "http://invalid.example.com:9999"
	defer func() { baseURL = oldBaseURL }()

	enrichment, err := FetchEnrichment(context.Background(), "GBUM71029604", "Title", "Artist")
	if err != nil {
		t.Fatalf("FetchEnrichment should not error, got: %v", err)
	}
	if enrichment == nil {
		t.Fatal("enrichment should not be nil (graceful degradation)")
	}
	if enrichment.Source != "listenbrainz" {
		t.Fatalf("source = %q, want listenbrainz", enrichment.Source)
	}
}

// Test FetchEnrichment respects context timeout
func TestFetchEnrichment_ContextTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate slow response
		<-r.Context().Done()
	}))
	defer server.Close()

	oldBaseURL := baseURL
	baseURL = server.URL
	defer func() { baseURL = oldBaseURL }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Already cancelled

	enrichment, err := FetchEnrichment(ctx, "GBUM71029604", "Title", "Artist")
	if err != nil {
		t.Fatalf("FetchEnrichment should not error on timeout, got: %v", err)
	}
	if enrichment == nil {
		t.Fatal("enrichment should not be nil (graceful degradation)")
	}
	if enrichment.Source != "listenbrainz" {
		t.Fatalf("source = %q, want listenbrainz", enrichment.Source)
	}
}
