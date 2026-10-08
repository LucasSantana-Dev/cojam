package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

// openEmpty opens a pool on a fresh, unmigrated private schema, so every
// migration runs from scratch here regardless of what other packages did.
func openEmpty(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	pool, err := db.Open(ctx, dbtest.Schema(t))
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	t.Cleanup(pool.Close)

	var schema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatalf("current_schema: %v", err)
	}
	if schema == "public" {
		t.Fatal("test pool resolved to the public schema, want a private one")
	}
	return pool
}

func TestOpenAndMigrate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool := openEmpty(t, ctx)

	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("Migrate failed: %v", err)
	}

	// Verify that the rooms table exists and has the expected columns.
	var colName string
	var colType string
	rows, err := pool.Query(ctx, `
		SELECT column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'rooms'
		ORDER BY ordinal_position
	`)
	if err != nil {
		t.Fatalf("failed to query columns: %v", err)
	}
	defer rows.Close()

	expectedColumns := map[string]string{
		"room_id":    "text",
		"state":      "jsonb",
		"version":    "bigint",
		"updated_at": "timestamp with time zone",
	}

	foundColumns := make(map[string]string)
	for rows.Next() {
		if err := rows.Scan(&colName, &colType); err != nil {
			t.Fatalf("failed to scan column: %v", err)
		}
		foundColumns[colName] = colType
	}

	if err := rows.Err(); err != nil {
		t.Fatalf("row iteration error: %v", err)
	}

	if len(foundColumns) != len(expectedColumns) {
		t.Fatalf("expected %d columns, got %d", len(expectedColumns), len(foundColumns))
	}

	for colName, colType := range expectedColumns {
		if foundType, ok := foundColumns[colName]; !ok {
			t.Errorf("missing column: %s", colName)
		} else if foundType != colType {
			t.Errorf("column %s: expected type %s, got %s", colName, colType, foundType)
		}
	}
}

func TestMigrateIdempotent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool := openEmpty(t, ctx)

	appliedCount := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&n); err != nil {
			t.Fatalf("count schema_migrations: %v", err)
		}
		return n
	}

	// First migration.
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("first Migrate failed: %v", err)
	}
	files, err := filepath.Glob("migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("list migration files: %v (found %d)", err, len(files))
	}
	first := appliedCount()
	if first != len(files) {
		t.Fatalf("first Migrate recorded %d versions, want %d (one per file)", first, len(files))
	}

	// Second migration (should be a no-op).
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("second Migrate failed: %v", err)
	}
	if second := appliedCount(); second != first {
		t.Fatalf("second Migrate changed recorded versions: %d, want %d", second, first)
	}

	// Verify the rooms table still exists and is unchanged.
	var tableExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = 'rooms'
		)
	`).Scan(&tableExists); err != nil {
		t.Fatalf("failed to check table existence: %v", err)
	}

	if !tableExists {
		t.Fatal("rooms table does not exist after second migration")
	}
}
