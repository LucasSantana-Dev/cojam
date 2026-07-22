package db

import (
	"context"
	"io/fs"
	"os"
	"testing"
	"time"
)

func TestOpenEmptyURL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := Open(ctx, "")
	if err == nil {
		t.Fatal("expected error for empty URL, got nil")
	}
}

func TestOpenInvalidURL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := Open(ctx, "not-a-valid-url")
	if err == nil {
		t.Fatal("expected error for invalid URL, got nil")
	}
}

func TestOpenAndMigrate(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping database tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer pool.Close()

	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("Migrate failed: %v", err)
	}

	// Verify that the rooms table exists and has the expected columns.
	var colName string
	var colType string
	rows, err := pool.Query(ctx, `
		SELECT column_name, data_type
		FROM information_schema.columns
		WHERE table_name = 'rooms'
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
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping database tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer pool.Close()

	// First migration.
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("first Migrate failed: %v", err)
	}

	// Second migration (should be a no-op).
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("second Migrate failed: %v", err)
	}

	// Verify the rooms table still exists and is unchanged.
	var tableExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM information_schema.tables WHERE table_name = 'rooms'
		)
	`).Scan(&tableExists); err != nil {
		t.Fatalf("failed to check table existence: %v", err)
	}

	if !tableExists {
		t.Fatal("rooms table does not exist after second migration")
	}
}

// TestSupabaseMigrationsReadable guards the embed wiring: migrateFrom must read
// files from the FS it is given (a past bug read every entry from the base FS,
// which made MigrateSupabase fail with "file does not exist" at startup).
func TestSupabaseMigrationsReadable(t *testing.T) {
	entries, err := fs.Glob(supabaseMigrationsFS, "migrations-supabase/*.sql")
	if err != nil {
		t.Fatalf("glob supabase migrations: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("no supabase migration files embedded")
	}
	for _, entry := range entries {
		if _, err := fs.ReadFile(supabaseMigrationsFS, entry); err != nil {
			t.Fatalf("read %s from supabase FS: %v", entry, err)
		}
	}
}

func TestHasAuthSchema(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping database tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer pool.Close()

	// Plain test Postgres has no Supabase auth schema.
	has, err := HasAuthSchema(ctx, pool)
	if err != nil {
		t.Fatalf("HasAuthSchema failed: %v", err)
	}
	if has {
		t.Fatal("HasAuthSchema = true on plain Postgres, want false")
	}

	if _, err := pool.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS auth"); err != nil {
		t.Fatalf("create auth schema: %v", err)
	}
	defer func() {
		if _, err := pool.Exec(context.Background(), "DROP SCHEMA auth CASCADE"); err != nil {
			t.Logf("cleanup: drop auth schema: %v", err)
		}
	}()

	has, err = HasAuthSchema(ctx, pool)
	if err != nil {
		t.Fatalf("HasAuthSchema failed: %v", err)
	}
	if !has {
		t.Fatal("HasAuthSchema = false after creating auth schema, want true")
	}
}
