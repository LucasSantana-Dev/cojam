package report

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

// Retention for reports and moderation actions (#319).
//
// The window is an owner decision, not an engineering one: a report may need
// to outlive the room it concerns for as long as an authority could ask about
// the incident (ECA Digital, #259). The default is therefore zero, meaning
// keep forever, until the owner sets REPORT_RETENTION_DAYS.
//
// The purge is by age only. Neither table has a status or resolution column,
// so there is no way to tell an open case from a closed one; holding a record
// past the window for an ongoing matter (legal hold) is out of scope and has to
// be done by raising the window or copying the record out before it expires.

// Purger deletes records created strictly before cutoff, oldest first, at most
// limit per call, and returns how many it removed.
type Purger interface {
	PurgeBefore(ctx context.Context, cutoff time.Time, limit int) (int64, error)
}

// RetentionTarget is one table the sweep purges. Table is a fixed name used
// for logs and the metric label, never user input.
type RetentionTarget struct {
	Table  string
	Purger Purger
}

// Retention periodically purges records older than a window.
type Retention struct {
	window   time.Duration
	batch    int
	targets  []RetentionTarget
	logger   *slog.Logger
	onPurged func(table string, n int64)
}

// defaultRetentionBatch replaces a non-positive batch, which Postgres would
// reject as a LIMIT.
const defaultRetentionBatch = 1000

// maxBatchesPerSweep bounds how many full batches one sweep deletes per table.
// Each DELETE stays bounded (short locks); the cap keeps one sweep from
// running unbounded on a first-enable backlog, and reaching it is logged.
const maxBatchesPerSweep = 10

// NewRetention builds a sweep that removes records older than window, in
// DELETEs of at most batch rows. A window <= 0 disables it entirely.
func NewRetention(window time.Duration, batch int, targets ...RetentionTarget) *Retention {
	if batch <= 0 {
		batch = defaultRetentionBatch
	}
	return &Retention{window: window, batch: batch, targets: targets}
}

// WithLogger sets the logger. Logs carry counts and the cutoff, never content.
func (r *Retention) WithLogger(l *slog.Logger) *Retention {
	r.logger = l
	return r
}

// WithPurgeObserver registers a callback for each non-empty purge, used to
// feed the Prometheus counter.
func (r *Retention) WithPurgeObserver(fn func(table string, n int64)) *Retention {
	r.onPurged = fn
	return r
}

// Enabled reports whether a positive window is configured.
func (r *Retention) Enabled() bool { return r.window > 0 }

// Sweep purges each table with cutoff now - window, one bounded DELETE at a
// time, repeating while a batch comes back full, up to maxBatchesPerSweep. A
// failure on one table is logged and does not skip the others; the next
// sweep retries. Time is injected so tests need no ticker.
func (r *Retention) Sweep(ctx context.Context, now time.Time) {
	if !r.Enabled() {
		return
	}
	cutoff := now.Add(-r.window)
	for _, t := range r.targets {
		var total int64
		full := false
		for i := 0; i < maxBatchesPerSweep; i++ {
			if ctx.Err() != nil {
				return
			}
			sweepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			removed, err := t.Purger.PurgeBefore(sweepCtx, cutoff, r.batch)
			cancel()
			if err != nil {
				if r.logger != nil {
					r.logger.Error("retention_purge_failed", "table", t.Table, "err", err.Error())
				}
				full = false
				break
			}
			total += removed
			full = removed >= int64(r.batch)
			if !full {
				break
			}
		}
		if total > 0 {
			if r.logger != nil {
				r.logger.Info("retention_purged", "table", t.Table, "removed", total, "cutoff", cutoff.UTC())
			}
			if r.onPurged != nil {
				r.onPurged(t.Table, total)
			}
		}
		if full && r.logger != nil {
			// Rows past the window remain after this sweep; the next one
			// continues. If this persists, ingestion outpaces the purge.
			r.logger.Warn("retention_backlog", "table", t.Table, "batches", maxBatchesPerSweep, "batch", r.batch)
		}
	}
}

// Start sweeps once immediately and then every interval, until the returned
// stop function is called. The immediate sweep matters: a server redeployed
// more often than the interval would otherwise never purge. stop cancels any
// in-flight query and returns after the loop has exited. A disabled
// retention starts nothing.
func (r *Retention) Start(interval time.Duration) (stop func()) {
	if !r.Enabled() {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	obs.SafeGo("report_retention", func() {
		defer close(done)
		r.Sweep(ctx, time.Now())
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				r.Sweep(ctx, now)
			}
		}
	})
	return func() {
		cancel()
		<-done
	}
}

// oldestBefore returns the indices of the records created before cutoff,
// oldest first, at most limit. Shared by the in-memory stores.
func oldestBefore(n int, createdAt func(int) time.Time, cutoff time.Time, limit int) map[int]struct{} {
	var idx []int
	for i := 0; i < n; i++ {
		if createdAt(i).Before(cutoff) {
			idx = append(idx, i)
		}
	}
	sort.SliceStable(idx, func(a, b int) bool { return createdAt(idx[a]).Before(createdAt(idx[b])) })
	if limit >= 0 && len(idx) > limit {
		idx = idx[:limit]
	}
	out := make(map[int]struct{}, len(idx))
	for _, i := range idx {
		out[i] = struct{}{}
	}
	return out
}

// PurgeBefore removes reports created strictly before cutoff, oldest first.
func (m *Memory) PurgeBefore(_ context.Context, cutoff time.Time, limit int) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	drop := oldestBefore(len(m.reports), func(i int) time.Time { return m.reports[i].CreatedAt }, cutoff, limit)
	kept := m.reports[:0]
	for i, r := range m.reports {
		if _, ok := drop[i]; !ok {
			kept = append(kept, r)
		}
	}
	// Zero the tail so purged records do not linger in the backing array:
	// retention is an erasure promise, and a heap dump would break it.
	clear(m.reports[len(kept):])
	m.reports = kept
	return int64(len(drop)), nil
}

// PurgeBefore removes actions created strictly before cutoff, oldest first.
func (m *MemoryAudit) PurgeBefore(_ context.Context, cutoff time.Time, limit int) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	drop := oldestBefore(len(m.actions), func(i int) time.Time { return m.actions[i].CreatedAt }, cutoff, limit)
	kept := m.actions[:0]
	for i, a := range m.actions {
		if _, ok := drop[i]; !ok {
			kept = append(kept, a)
		}
	}
	clear(m.actions[len(kept):])
	m.actions = kept
	return int64(len(drop)), nil
}

// PurgeBefore deletes reports created strictly before cutoff, oldest first,
// in one statement bounded by limit so a large backlog never holds a long
// lock; the remainder goes on the next sweep. Uses reports_created_at_idx.
func (p *Postgres) PurgeBefore(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	tag, err := p.pool.Exec(ctx, `
		DELETE FROM reports WHERE id IN (
			SELECT id FROM reports WHERE created_at < $1 ORDER BY created_at LIMIT $2
		)
	`, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("failed to purge reports: %w", err)
	}
	return tag.RowsAffected(), nil
}

// PurgeBefore deletes moderation actions created strictly before cutoff,
// oldest first, bounded by limit.
func (p *PostgresAudit) PurgeBefore(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	tag, err := p.pool.Exec(ctx, `
		DELETE FROM moderation_actions WHERE id IN (
			SELECT id FROM moderation_actions WHERE created_at < $1 ORDER BY created_at LIMIT $2
		)
	`, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("failed to purge moderation actions: %w", err)
	}
	return tag.RowsAffected(), nil
}
