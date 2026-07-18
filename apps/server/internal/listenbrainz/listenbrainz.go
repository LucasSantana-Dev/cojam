// Package listenbrainz provides enrichment data from ListenBrainz API.
// ListenBrainz is a crowdsourced music database with no API key requirement.
// It provides tags and listen counts for recordings identified by ISRC or MBID.
package listenbrainz

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
)

// baseURL is the ListenBrainz API base URL (package-level for testability via httptest injection).
var baseURL = "https://api.listenbrainz.org/api/v1"

// Enrichment represents ListenBrainz enrichment data for a track.
type Enrichment struct {
	MBID  string   `json:"mbid,omitempty"`        // MusicBrainz ID of the recording
	Tags  []string `json:"tags"`                  // Crowdsourced tags
	Count int      `json:"count,omitempty"`       // Listen count (if available)
	Source string  `json:"source"`                // Always "listenbrainz"
}

// recordingByISRC is the response from /recording-by-isrc/{isrc}
type recordingByISRC struct {
	ISRC       string `json:"isrc"`
	Recordings []struct {
		ID     string `json:"id"`     // MBID
		Title  string `json:"title"`
		Artists []struct {
			Name string `json:"name"`
		} `json:"artists"`
	} `json:"recordings"`
}

// FetchEnrichment queries ListenBrainz for enrichment data about a track.
// It attempts to resolve the track by ISRC first, then falls back to empty result.
// Returns a graceful empty enrichment on any error (network, timeout, no data).
// No API key is required.
func FetchEnrichment(ctx context.Context, isrc, title, artist string) (*Enrichment, error) {
	// Default graceful empty result
	result := &Enrichment{
		Tags:   []string{},
		Source: "listenbrainz",
	}

	// If no ISRC, return empty gracefully
	if isrc == "" {
		return result, nil
	}

	// Try to resolve ISRC to MBID
	mbid, err := resolveISRC(ctx, strings.ToUpper(isrc))
	if err != nil || mbid == "" {
		// No MBID found or network error; return gracefully
		return result, nil
	}

	result.MBID = mbid

	// Fetch tags for this MBID (best-effort; error is non-fatal)
	tags, err := fetchTags(ctx, mbid)
	if err == nil {
		result.Tags = tags
	}

	return result, nil
}

// resolveISRC queries ListenBrainz to resolve an ISRC code to a MusicBrainz ID.
func resolveISRC(ctx context.Context, isrc string) (string, error) {
	isrc = strings.ToUpper(isrc)
	url := fmt.Sprintf("%s/recording-by-isrc/%s", baseURL, url.QueryEscape(isrc))

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "cojam/0.1 (https://github.com/LucasSantana-Dev/cojam)")

	var resp recordingByISRC
	if err := httpx.DoJSON(req, &resp); err != nil {
		return "", err
	}

	// Extract MBID from first recording
	if len(resp.Recordings) > 0 && resp.Recordings[0].ID != "" {
		return resp.Recordings[0].ID, nil
	}

	return "", nil
}

// fetchTags queries ListenBrainz for crowdsourced tags on a recording.
type tagsResponse struct {
	Tags []struct {
		Tag   string `json:"tag"`
		Count int    `json:"count"`
	} `json:"tags"`
}

func fetchTags(ctx context.Context, mbid string) ([]string, error) {
	if mbid == "" {
		return []string{}, nil
	}

	url := fmt.Sprintf("%s/tags/recording/%s", baseURL, url.QueryEscape(mbid))

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return []string{}, err
	}
	req.Header.Set("User-Agent", "cojam/0.1 (https://github.com/LucasSantana-Dev/cojam)")

	var resp tagsResponse
	if err := httpx.DoJSON(req, &resp); err != nil {
		// Return empty tags on error (non-fatal)
		return []string{}, nil
	}

	tags := make([]string, len(resp.Tags))
	for i, t := range resp.Tags {
		tags[i] = t.Tag
	}

	return tags, nil
}
