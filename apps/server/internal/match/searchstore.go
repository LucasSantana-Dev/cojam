package match

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TTLs of the persistent search cache. An empty result expires sooner: the
// catalogue gains videos, and a miss should not be sticky for a month.
const (
	SearchStoreTTL      = 30 * 24 * time.Hour
	SearchStoreEmptyTTL = 24 * time.Hour

	// searchStoreMaxKey bounds the key; longer queries skip the persistent
	// cache (they are caller-controlled).
	searchStoreMaxKey = 512
	// searchStoreTimeout bounds each cache round trip: the cache is an
	// optimisation and must never hold up matching.
	searchStoreTimeout = 2 * time.Second
)

// SearchStore persists YouTube search results across restarts (L2 under the
// in-memory cache). Implementations return found=false for a missing or
// expired row.
type SearchStore interface {
	Get(ctx context.Context, key string) (cands []YouTubeCandidate, found bool, err error)
	Put(ctx context.Context, key string, cands []YouTubeCandidate, ttl time.Duration) error
}

var searchStore = struct {
	sync.RWMutex
	s SearchStore
}{}

// SetSearchStore installs the persistent cache (nil disables it). Call at
// startup, only when a database is configured.
func SetSearchStore(s SearchStore) {
	searchStore.Lock()
	searchStore.s = s
	searchStore.Unlock()
}

func currentSearchStore() SearchStore {
	searchStore.RLock()
	defer searchStore.RUnlock()
	return searchStore.s
}

// searchStoreGet reads through the persistent cache. Any failure degrades to
// a miss (the API is called instead).
func searchStoreGet(ctx context.Context, key string) ([]YouTubeCandidate, bool) {
	st := currentSearchStore()
	if st == nil || len(key) > searchStoreMaxKey {
		return nil, false
	}
	c, cancel := context.WithTimeout(ctx, searchStoreTimeout)
	defer cancel()
	cands, found, err := st.Get(c, key)
	if err != nil {
		slog.Warn("youtube_search_cache_read_failed", "err", err.Error())
		return nil, false
	}
	return cands, found
}

// searchStorePut writes through. Only successful searches reach it; a failure
// is logged and ignored.
func searchStorePut(ctx context.Context, key string, cands []YouTubeCandidate) {
	st := currentSearchStore()
	if st == nil || len(key) > searchStoreMaxKey {
		return
	}
	ttl := SearchStoreTTL
	if len(cands) == 0 {
		ttl = SearchStoreEmptyTTL
	}
	// Detach from the lookup's deadline: the search already succeeded, losing
	// the write would repay its quota.
	c, cancel := context.WithTimeout(context.WithoutCancel(ctx), searchStoreTimeout)
	defer cancel()
	if err := st.Put(c, key, cands, ttl); err != nil {
		slog.Warn("youtube_search_cache_write_failed", "err", err.Error())
	}
}

// PostgresSearchStore is the SearchStore over the youtube_search_cache table.
type PostgresSearchStore struct{ pool *pgxpool.Pool }

// NewPostgresSearchStore wraps a migrated pool.
func NewPostgresSearchStore(pool *pgxpool.Pool) *PostgresSearchStore {
	return &PostgresSearchStore{pool: pool}
}

func (p *PostgresSearchStore) Get(ctx context.Context, key string) ([]YouTubeCandidate, bool, error) {
	var raw []byte
	err := p.pool.QueryRow(ctx,
		`SELECT candidates FROM youtube_search_cache WHERE query_key = $1 AND expires_at > now()`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	cands := []YouTubeCandidate{}
	if err := json.Unmarshal(raw, &cands); err != nil {
		return nil, false, err
	}
	return cands, true, nil
}

func (p *PostgresSearchStore) Put(ctx context.Context, key string, cands []YouTubeCandidate, ttl time.Duration) error {
	if cands == nil {
		cands = []YouTubeCandidate{}
	}
	raw, err := json.Marshal(cands)
	if err != nil {
		return err
	}
	_, err = p.pool.Exec(ctx, `
		INSERT INTO youtube_search_cache (query_key, candidates, expires_at)
		VALUES ($1, $2, now() + $3 * interval '1 second')
		ON CONFLICT (query_key) DO UPDATE
		SET candidates = excluded.candidates, expires_at = excluded.expires_at, created_at = now()
	`, key, raw, ttl.Seconds())
	return err
}

// Purge deletes rows that expired more than a day ago and returns how many.
func (p *PostgresSearchStore) Purge(ctx context.Context) (int64, error) {
	tag, err := p.pool.Exec(ctx, `DELETE FROM youtube_search_cache WHERE expires_at < now() - interval '1 day'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
