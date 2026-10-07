package dbtest_test

import (
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

const (
	stressIterations = 20
	stressWorkers    = 8
)

// workerCount caps stressWorkers at -test.parallel: the barrier needs every
// worker running at once, or the started ones wait forever for the rest.
func workerCount() int {
	n := stressWorkers
	if f := flag.Lookup("test.parallel"); f != nil {
		if p, err := strconv.Atoi(f.Value.String()); err == nil && p < n {
			n = p
		}
	}
	return n
}

// TestConcurrentMigrateStress is a regression test for the CI failure that
// motivated this package: concurrent db.Migrate runs on the shared public
// schema of a fresh database collide on pg_type_typname_nsp_index.
//
// Plain `go test ./...` loops almost never overlap the migrations closely
// enough to show it, so this test holds stressWorkers goroutines at a barrier
// and releases them into db.Migrate together, on a brand-new database per
// iteration. It runs a control (everyone on public), which must reproduce the
// collision for the result to mean anything, and then the dbtest.Schema path,
// which must never fail.
//
// Skipped unless DBTEST_STRESS_ADMIN_URL points at a maintenance database
// (for example postgres://user@host:5432/postgres) whose user may CREATE and
// DROP DATABASE.
func TestConcurrentMigrateStress(t *testing.T) {
	adminURL := os.Getenv("DBTEST_STRESS_ADMIN_URL")
	if adminURL == "" {
		t.Skip("DBTEST_STRESS_ADMIN_URL not set")
	}
	if workerCount() < 2 {
		t.Skip("needs -parallel of at least 2")
	}
	ctx := context.Background()
	admin, err := db.Open(ctx, adminURL)
	if err != nil {
		t.Fatalf("open admin database: %v", err)
	}
	defer admin.Close()

	control, controlErrs := stressMigrate(t, admin, adminURL, false)
	t.Logf("shared public: %d/%d iterations failed, errors %v", control, stressIterations, controlErrs)

	isolated, isolatedErrs := stressMigrate(t, admin, adminURL, true)
	t.Logf("dbtest.Schema: %d/%d iterations failed, errors %v", isolated, stressIterations, isolatedErrs)

	if isolated != 0 {
		t.Errorf("concurrent migrations on private schemas failed in %d/%d iterations: %v",
			isolated, stressIterations, isolatedErrs)
	}
	if control == 0 {
		t.Skip("control never reproduced the collision, so the isolated result proves nothing on this machine")
	}
}

// stressMigrate runs stressIterations rounds, each on a new database, and
// returns how many rounds saw a migration error plus the errors by kind.
func stressMigrate(t *testing.T, admin *pgxpool.Pool, adminURL string, isolated bool) (int, map[string]int) {
	t.Helper()
	ctx := context.Background()
	mode := "public"
	if isolated {
		mode = "isolated"
	}

	var mu sync.Mutex
	failedRounds := 0
	kinds := map[string]int{}

	for i := 0; i < stressIterations; i++ {
		name := fmt.Sprintf("dbtest_stress_%s_%d", mode, i)
		if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Fatalf("drop stale %s: %v", name, err)
		}
		if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		u, err := url.Parse(adminURL)
		if err != nil {
			t.Fatalf("parse DBTEST_STRESS_ADMIN_URL: %v", err)
		}
		u.Path = "/" + name
		dbURL := u.String()
		// dbtest.Schema reads TEST_DATABASE_URL.
		t.Setenv("TEST_DATABASE_URL", dbURL)

		workers := workerCount()
		var ready, start sync.WaitGroup
		ready.Add(workers)
		start.Add(1)
		roundFailed := false
		t.Run(fmt.Sprintf("%s/%d", mode, i), func(t *testing.T) {
			for w := 0; w < workers; w++ {
				t.Run(fmt.Sprint(w), func(t *testing.T) {
					t.Parallel()
					target := dbURL
					if isolated {
						target = dbtest.Schema(t)
					}
					pool, err := db.Open(ctx, target)
					ready.Done()
					if err != nil {
						t.Errorf("open: %v", err)
						return
					}
					defer pool.Close()
					start.Wait()
					if err := db.Migrate(ctx, pool); err != nil {
						mu.Lock()
						roundFailed = true
						kinds[classifyMigrateError(err)]++
						mu.Unlock()
					}
				})
			}
			// Parallel subtests start once this function returns; release
			// them into Migrate together when all have their pools open.
			go func() { ready.Wait(); start.Done() }()
		})
		if roundFailed {
			failedRounds++
		}
		if _, err := admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Fatalf("drop %s: %v", name, err)
		}
	}
	return failedRounds, kinds
}

func classifyMigrateError(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "pg_type_typname_nsp_index"):
		return "pg_type_typname_nsp_index"
	case strings.Contains(s, "already exists"):
		return "already_exists"
	default:
		return "other: " + s
	}
}
