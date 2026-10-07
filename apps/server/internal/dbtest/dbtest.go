// Package dbtest gives Postgres-backed tests a private schema each.
//
// go test runs packages in parallel, so tests that migrated the shared public
// schema of TEST_DATABASE_URL raced each other on a fresh database (duplicate
// pg_type errors during CREATE TABLE) and saw each other's rows. Every helper
// here creates a uniquely named schema, points the returned connection at it
// via search_path, and drops it when the test ends.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
)

// Schema creates an empty private schema and returns a database URL whose
// search_path selects it. The test is skipped when TEST_DATABASE_URL is unset.
// Use it to exercise migrations themselves; most tests want Isolated.
func Schema(t testing.TB) string {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	admin, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("dbtest: open database: %v", err)
	}
	b := make([]byte, 8)
	rand.Read(b)
	schema := "test_" + hex.EncodeToString(b)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("dbtest: create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Logf("dbtest: drop schema %s: %v", schema, err)
		}
		admin.Close()
	})

	u, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("dbtest: parse TEST_DATABASE_URL: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String()
}

// Isolated returns a pool on a private, fully migrated schema. The pool is
// closed and the schema dropped when the test ends. The test is skipped when
// TEST_DATABASE_URL is unset.
func Isolated(t testing.TB) *pgxpool.Pool {
	t.Helper()
	dbURL := Schema(t)
	ctx := context.Background()

	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("dbtest: open isolated database: %v", err)
	}
	// Registered after Schema's cleanup, so it runs first: the pool closes
	// before the schema is dropped.
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("dbtest: migrate: %v", err)
	}
	return pool
}
