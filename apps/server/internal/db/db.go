// Package db holds the database layer: connection pool, schema, and migrations.
package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open opens a connection pool to the PostgreSQL database at the given URL.
// Returns a typed error if the URL is empty or unparseable.
// Pings the database before returning to verify connectivity.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	if url == "" {
		return nil, fmt.Errorf("database URL is empty")
	}

	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database URL: %w", err)
	}

	// Avoid server-side NAMED prepared statements: they break behind a
	// PgBouncer-style pooler in transaction mode, which is what most hosted
	// Postgres (Fly MPG, Neon, Supabase) front the pooled URL with. CacheDescribe
	// still learns parameter/result types (so jsonb/bigint encode correctly) but
	// executes via the unnamed statement, which transaction-mode pooling allows.
	// (Plain Exec mode does NOT learn types and mis-encodes our jsonb column.)
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return pool, nil
}

// Migrate applies pending migrations idempotently.
// Uses a schema_migrations tracking table and applies each embedded *.sql file
// whose version is not yet recorded, in filename order, each inside a transaction.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	// Create schema_migrations table if it doesn't exist. DDL returns no rows, so
	// use Exec (not QueryRow) and surface a real failure instead of swallowing it.
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`); err != nil {
		return fmt.Errorf("failed to create schema_migrations table: %w", err)
	}

	// Read all migration files from the embedded filesystem.
	entries, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("failed to list migration files: %w", err)
	}

	for _, entry := range entries {
		version := strings.TrimSuffix(filepath.Base(entry), ".sql")

		// Check if this migration has already been applied.
		var applied bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)", version).Scan(&applied); err != nil {
			return fmt.Errorf("failed to check migration status for %s: %w", version, err)
		}

		if applied {
			continue
		}

		// Read the migration file.
		content, err := fs.ReadFile(migrationsFS, entry)
		if err != nil {
			return fmt.Errorf("failed to read migration file %s: %w", entry, err)
		}

		// Execute the migration inside a transaction.
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("failed to begin transaction for %s: %w", version, err)
		}

		if _, err := tx.Exec(ctx, string(content)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("failed to execute migration %s: %w", version, err)
		}

		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("failed to record migration %s: %w", version, err)
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("failed to commit migration %s: %w", version, err)
		}
	}

	return nil
}
