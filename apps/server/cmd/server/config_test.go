package main

import (
	"strings"
	"testing"
)

// validProd is a production environment with nothing wrong; each test case
// removes or corrupts exactly one key.
func validProd() map[string]string {
	return map[string]string{
		"APP_ENV": "production",
		// The validator only checks for non-empty, so this stays credential-free
		// to avoid tripping secret scanners on a fixture.
		"DATABASE_URL":          "postgres://example/db",
		"CORS_ORIGINS":          "https://cojam.example",
		"METRICS_ADDR":          "127.0.0.1:9100",
		"FEATURE_ROOM_AUTH":     "true",
		"ROOM_AUTH_SECRET":      "s3cret",
		"FEATURE_SUPABASE_AUTH": "true",
		"SUPABASE_URL":          "https://project.supabase.co",
		"SUPABASE_JWT_SECRET":   "jwt",
	}
}

func TestValidateProdConfig(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(map[string]string)
		wantFatal string // substring; empty means no fatal problems
	}{
		{"clean production boot", func(map[string]string) {}, ""},
		{"database url unset", func(e map[string]string) { delete(e, "DATABASE_URL") }, "DATABASE_URL"},
		{"cors origins unset", func(e map[string]string) { delete(e, "CORS_ORIGINS") }, "CORS_ORIGINS"},
		{"cors origins wildcard", func(e map[string]string) { e["CORS_ORIGINS"] = "*" }, `CORS_ORIGINS contains "*"`},
		{"room auth secret missing", func(e map[string]string) { delete(e, "ROOM_AUTH_SECRET") }, "ROOM_AUTH_SECRET"},
		{"room auth off so secret not needed", func(e map[string]string) {
			e["FEATURE_ROOM_AUTH"] = "false"
			delete(e, "ROOM_AUTH_SECRET")
		}, ""},
		{"supabase creds missing", func(e map[string]string) {
			delete(e, "SUPABASE_URL")
			delete(e, "SUPABASE_JWT_SECRET")
		}, "FEATURE_SUPABASE_AUTH"},
		{"supabase off so creds not needed", func(e map[string]string) {
			e["FEATURE_SUPABASE_AUTH"] = "false"
			delete(e, "SUPABASE_URL")
			delete(e, "SUPABASE_JWT_SECRET")
		}, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := validProd()
			tt.mutate(env)

			fatal, _ := validateProdConfig(func(k string) string { return env[k] })

			if tt.wantFatal == "" {
				if len(fatal) > 0 {
					t.Fatalf("expected no fatal problems, got %v", fatal)
				}
				return
			}
			if !strings.Contains(strings.Join(fatal, "\n"), tt.wantFatal) {
				t.Fatalf("expected a fatal problem mentioning %q, got %v", tt.wantFatal, fatal)
			}
		})
	}
}

// Outside production the permissive defaults must survive untouched, otherwise
// every local `go run ./cmd/server` starts failing.
func TestValidateProdConfig_SkipsOutsideProduction(t *testing.T) {
	for _, appEnv := range []string{"", "development", "test"} {
		fatal, warn := validateProdConfig(func(k string) string {
			if k == "APP_ENV" {
				return appEnv
			}
			return ""
		})
		if len(fatal) > 0 || len(warn) > 0 {
			t.Fatalf("APP_ENV=%q: expected no problems, got fatal=%v warn=%v", appEnv, fatal, warn)
		}
	}
}

func TestValidateProdConfig_MetricsAddrWarnsNotFatal(t *testing.T) {
	env := validProd()
	delete(env, "METRICS_ADDR")

	fatal, warn := validateProdConfig(func(k string) string { return env[k] })

	if len(fatal) > 0 {
		t.Fatalf("METRICS_ADDR should not be fatal, got %v", fatal)
	}
	if !strings.Contains(strings.Join(warn, "\n"), "METRICS_ADDR") {
		t.Fatalf("expected a METRICS_ADDR warning, got %v", warn)
	}
}
