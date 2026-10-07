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
