package match

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
)

const (
	mbUserAgent = "CoJam/1.0 ( https://cojam.lucassantana.tech )"
	// mbMinScore is the lowest Lucene relevance score we trust for a search
	// hit. MusicBrainz scores an exact title+artist match at 100.
	mbMinScore   = 70
	mbMaxCredits = 12
	mbMaxTags    = 5
	// mbRecordingInc is the valid inc set for /recording/<mbid>. "labels" is
	// NOT valid on a recording (400); the label comes from a /release lookup.
	mbRecordingInc  = "artist-credits+releases+artist-rels+work-rels+work-level-rels+tags"
	mbDepthCacheMax = 1024
)

var (
	// mbMinInterval is the spacing between MusicBrainz requests. Their policy
	// is 1 request per second per client; the margin keeps bursts under it.
	// Package-level so tests can shrink it.
	mbMinInterval = 1100 * time.Millisecond
	mbMu          sync.Mutex
	mbNext        time.Time

	depthCacheMu sync.Mutex
	depthCache   = map[string]*TrackDepth{}
	depthOrder   []string // insertion order, for single-entry eviction

	inflightMu sync.Mutex
	inflight   = map[string]*depthCall{}
)

type depthCall struct {
	done chan struct{}
	res  *TrackDepth
	err  error
}

// waitMusicBrainz blocks until the caller may send the next MusicBrainz
// request, or ctx ends. Slots are reserved under a mutex, so concurrent callers
// queue one interval apart instead of racing for a shared tick. A caller whose
// deadline falls before its slot fails fast without reserving, and a caller
// cancelled while waiting hands its slot back if it is still the last one, so
// timed-out requests cannot poison the queue for everyone behind them.
func waitMusicBrainz(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	mbMu.Lock()
	slot := time.Now()
	if slot.Before(mbNext) {
		slot = mbNext
	}
	if dl, ok := ctx.Deadline(); ok && slot.After(dl) {
		mbMu.Unlock()
		return context.DeadlineExceeded
	}
	mbNext = slot.Add(mbMinInterval)
	end := mbNext
	mbMu.Unlock()

	d := time.Until(slot)
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		mbMu.Lock()
		if mbNext.Equal(end) {
			mbNext = slot
		}
		mbMu.Unlock()
		return ctx.Err()
	}
}

// mbRecording is the subset of a MusicBrainz recording we read. The search
// endpoint fills ID, Title, Score, FirstReleaseDate and Releases; the lookup
// endpoint (with inc=) also fills Relations, label-info and Tags.
type mbRecording struct {
	ID               string       `json:"id"`
	Title            string       `json:"title"`
	Score            int          `json:"score"`
	FirstReleaseDate string       `json:"first-release-date"`
	Releases         []mbRelease  `json:"releases"`
	Relations        []mbRelation `json:"relations"`
	Tags             []struct {
		Count int    `json:"count"`
		Name  string `json:"name"`
	} `json:"tags"`
}

type mbRelease struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Date      string `json:"date"`
	LabelInfo []struct {
		Label struct {
			Name string `json:"name"`
		} `json:"label"`
	} `json:"label-info"`
}

type mbRelation struct {
	Type   string `json:"type"`
	Artist *struct {
		Name string `json:"name"`
	} `json:"artist"`
	// Work is set on "performance" relations (inc=work-rels); its own relations
	// (inc=work-level-rels) carry composer and lyricist.
	Work *struct {
		Relations []mbRelation `json:"relations"`
	} `json:"work"`
}

var (
	// Version suffixes streaming services append to titles. Stripped for the
	// search only, so "Song - Radio Edit" finds the "Song" recording. Remixes
	// and live versions are different recordings and are kept, as is anything
	// trailing the suffix: "Song - Radio Edit (Live)" becomes "Song (Live)".
	versionKW        = `(?:radio edit|single version|album version|(?:mono|stereo) version|explicit|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?)`
	versionDashRe    = regexp.MustCompile(`(?i)\s*-\s*` + versionKW + `(\s*[(\[].*)?$`)
	versionBracketRe = regexp.MustCompile(`(?i)\s*[(\[]\s*` + versionKW + `\s*[)\]]\s*$`)
	// Featured artists only. Commas and ampersands are left alone: they are
	// part of band names ("Earth, Wind & Fire", "Simon & Garfunkel").
	secondaryArtistRe = regexp.MustCompile(`(?i)\s*[(\[]?\s*\b(?:feat\.?|ft\.?|featuring)\s+.*$`)
	luceneEscaper     = strings.NewReplacer(`\`, `\\`, `"`, `\"`)
)

// searchTitle strips common version suffixes ("- Radio Edit", "(Remastered 2011)").
func searchTitle(title string) string {
	t := strings.TrimSpace(title)
	for i := 0; i < 2; i++ {
		next := strings.TrimSpace(versionBracketRe.ReplaceAllString(versionDashRe.ReplaceAllString(t, "$1"), ""))
		if next == t || next == "" {
			break
		}
		t = next
	}
	return t
}

func searchArtist(artist string) string {
	a := strings.TrimSpace(artist)
	if b := strings.TrimSpace(secondaryArtistRe.ReplaceAllString(a, "")); b != "" {
		return b
	}
	return a
}

// recordingQuery builds the Lucene query: both fields as quoted phrases, so a
// free-text word match on an unrelated recording cannot outrank the real one.
func recordingQuery(title, artist string) string {
	return fmt.Sprintf(`recording:"%s" AND artist:"%s"`,
		luceneEscaper.Replace(searchTitle(title)),
		luceneEscaper.Replace(searchArtist(artist)))
}

func newDepth() *TrackDepth {
	return &TrackDepth{Credits: []TrackDepthCredit{}, Tags: []string{}, Source: "musicbrainz"}
}

func depthCacheKey(isrc, title, artist string) string {
	return strings.ToLower(isrc + "|" + title + "|" + artist)
}

func mbGet(ctx context.Context, rawURL string, v any) error {
	req, err := http.NewRequestWithContext(httpx.WithOp(ctx, "isrc"), "GET", rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", mbUserAgent)
	req.Header.Set("Accept", "application/json")
	if err := waitMusicBrainz(ctx); err != nil {
		return err
	}
	return httpx.DoJSON(req, v)
}

func isNotFoundErr(err error) bool {
	var se *httpx.StatusError
	return errors.As(err, &se) && se.Code == http.StatusNotFound
}

// FetchTrackDepth fetches deep metadata for a track from MusicBrainz.
// An ISRC is the authoritative lookup; otherwise a quoted title+artist search.
// The matched recording is then looked up by MBID for credits and label, which
// the search endpoint does not return. Results are cached in memory; a failed
// upstream call is returned as an error and never cached. A track MusicBrainz
// does not know yields an empty result with a nil error.
func FetchTrackDepth(ctx context.Context, isrc, title, artist string) (*TrackDepth, error) {
	key := depthCacheKey(isrc, title, artist)
	depthCacheMu.Lock()
	if hit, ok := depthCache[key]; ok {
		depthCacheMu.Unlock()
		return hit, nil
	}
	depthCacheMu.Unlock()

	// Collapse concurrent identical requests into one upstream sequence, so a
	// burst of rooms on the same track costs one slot, not N.
	inflightMu.Lock()
	if c, ok := inflight[key]; ok {
		inflightMu.Unlock()
		select {
		case <-c.done:
			return c.res, c.err
		case <-ctx.Done():
			return newDepth(), ctx.Err()
		}
	}
	c := &depthCall{done: make(chan struct{})}
	inflight[key] = c
	inflightMu.Unlock()
	c.res, c.err = fetchTrackDepth(ctx, key, isrc, title, artist)
	inflightMu.Lock()
	delete(inflight, key)
	inflightMu.Unlock()
	close(c.done)
	return c.res, c.err
}

func fetchTrackDepth(ctx context.Context, key, isrc, title, artist string) (*TrackDepth, error) {
	var base *mbRecording
	var isrcErr, searchErr error

	if isrc != "" {
		var resp struct {
			Recordings []mbRecording `json:"recordings"`
		}
		u := fmt.Sprintf("%s/isrc/%s?fmt=json&inc=releases", musicbrainzURL, url.QueryEscape(strings.ToUpper(isrc)))
		if err := mbGet(ctx, u, &resp); err != nil {
			if !isNotFoundErr(err) {
				isrcErr = err
			}
		} else if len(resp.Recordings) > 0 {
			base = &resp.Recordings[0]
		}
	}

	if base == nil && title != "" && artist != "" {
		var resp struct {
			Recordings []mbRecording `json:"recordings"`
		}
		u := fmt.Sprintf("%s/recording?query=%s&fmt=json&limit=5", musicbrainzURL, url.QueryEscape(recordingQuery(title, artist)))
		if err := mbGet(ctx, u, &resp); err != nil {
			if !isNotFoundErr(err) {
				searchErr = err
			}
		} else {
			for i := range resp.Recordings {
				if resp.Recordings[i].Score >= mbMinScore {
					base = &resp.Recordings[i]
					break
				}
			}
		}
	}

	if base == nil {
		// An ISRC outage is not erased by a clean search with no hit: the
		// authoritative lookup never answered, so do not cache an empty result.
		// The hub logs the returned error once.
		if isrcErr != nil {
			return newDepth(), isrcErr
		}
		if searchErr != nil {
			return newDepth(), searchErr
		}
		res := newDepth()
		storeDepth(key, res)
		return res, nil
	}

	merged := []*mbRecording{base}
	complete := true
	if base.ID != "" {
		var full mbRecording
		u := fmt.Sprintf("%s/recording/%s?fmt=json&inc="+mbRecordingInc+"",
			musicbrainzURL, url.PathEscape(base.ID))
		if err := mbGet(ctx, u, &full); err != nil {
			complete = false
			slog.Warn("trackdepth_lookup_failed", "err", err.Error())
		} else {
			merged = append(merged, &full)
		}
	}

	res := extractTrackDepth(merged...)
	if res.Label == "" {
		if rid := earliestReleaseID(merged...); rid != "" {
			var rel struct {
				LabelInfo []struct {
					Label struct {
						Name string `json:"name"`
					} `json:"label"`
				} `json:"label-info"`
			}
			u := fmt.Sprintf("%s/release/%s?fmt=json&inc=labels", musicbrainzURL, url.PathEscape(rid))
			if err := mbGet(ctx, u, &rel); err != nil {
				complete = false
				slog.Warn("trackdepth_label_failed", "err", err.Error())
			} else {
				for _, li := range rel.LabelInfo {
					if li.Label.Name != "" {
						res.Label = li.Label.Name
						break
					}
				}
			}
		}
	}
	if complete {
		storeDepth(key, res)
	}
	return res, nil
}

// earliestReleaseID returns the id of the earliest dated release, whose label
// best describes the original issue.
func earliestReleaseID(recs ...*mbRecording) string {
	best, bestDate := "", ""
	for _, rec := range recs {
		for _, r := range rec.Releases {
			if r.ID != "" && yearOf(r.Date) > 0 && (bestDate == "" || r.Date < bestDate) {
				best, bestDate = r.ID, r.Date
			}
		}
	}
	return best
}

func storeDepth(key string, d *TrackDepth) {
	depthCacheMu.Lock()
	defer depthCacheMu.Unlock()
	if _, exists := depthCache[key]; !exists {
		if len(depthCache) >= mbDepthCacheMax && len(depthOrder) > 0 {
			delete(depthCache, depthOrder[0])
			depthOrder = depthOrder[1:]
		}
		depthOrder = append(depthOrder, key)
	}
	depthCache[key] = d
}

// yearOf parses the leading YYYY of a MusicBrainz date ("1975", "1975-10-31").
func yearOf(date string) int {
	if len(date) < 4 {
		return 0
	}
	y, err := strconv.Atoi(date[:4])
	if err != nil || y < 1000 {
		return 0
	}
	return y
}

// extractTrackDepth folds one or more views of the same recording (search hit,
// then lookup) into a TrackDepth.
func extractTrackDepth(recs ...*mbRecording) *TrackDepth {
	res := newDepth()

	var releases []mbRelease
	var relations []mbRelation
	tagCounts := map[string]int{}
	var tagOrder []string
	for _, rec := range recs {
		if y := yearOf(rec.FirstReleaseDate); y > 0 && (res.ReleaseYear == 0 || y < res.ReleaseYear) {
			res.ReleaseYear = y
		}
		releases = append(releases, rec.Releases...)
		relations = append(relations, rec.Relations...)
		for _, tag := range rec.Tags {
			if tag.Name == "" {
				continue
			}
			if _, seen := tagCounts[tag.Name]; !seen {
				tagOrder = append(tagOrder, tag.Name)
			}
			if tag.Count > tagCounts[tag.Name] {
				tagCounts[tag.Name] = tag.Count
			}
		}
	}

	// Earliest dated release first: its year and label describe the original
	// issue rather than a later compilation.
	sort.SliceStable(releases, func(i, j int) bool {
		a, b := yearOf(releases[i].Date), yearOf(releases[j].Date)
		if a == 0 || b == 0 {
			return a != 0 && b == 0
		}
		return releases[i].Date < releases[j].Date
	})
	for _, r := range releases {
		if y := yearOf(r.Date); y > 0 && (res.ReleaseYear == 0 || y < res.ReleaseYear) {
			res.ReleaseYear = y
		}
	}
	for _, r := range releases {
		for _, li := range r.LabelInfo {
			if li.Label.Name != "" {
				res.Label = li.Label.Name
				break
			}
		}
		if res.Label != "" {
			break
		}
	}

	seen := map[string]bool{}
	add := func(role, name string) {
		k := role + "|" + name
		if name == "" || seen[k] || len(res.Credits) >= mbMaxCredits {
			return
		}
		seen[k] = true
		res.Credits = append(res.Credits, TrackDepthCredit{Role: role, Name: name})
	}
	for _, rel := range relations {
		if rel.Artist != nil {
			add(rel.Type, rel.Artist.Name)
		}
		if rel.Work != nil {
			for _, wr := range rel.Work.Relations {
				if wr.Artist != nil {
					add(wr.Type, wr.Artist.Name)
				}
			}
		}
	}

	sort.SliceStable(tagOrder, func(i, j int) bool { return tagCounts[tagOrder[i]] > tagCounts[tagOrder[j]] })
	for i, name := range tagOrder {
		if i >= mbMaxTags {
			break
		}
		res.Tags = append(res.Tags, name)
	}
	return res
}
