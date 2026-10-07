package main

import (
	"strings"
	"testing"
	"time"
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
		"ROOM_AUTH_SECRET":      strings.Repeat("k", minRoomAuthSecretLen),
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
		{"room auth secret too short", func(e map[string]string) {
			e["ROOM_AUTH_SECRET"] = strings.Repeat("k", minRoomAuthSecretLen-1)
		}, "ROOM_AUTH_SECRET is shorter than"},
		{"room auth off so short secret is ignored", func(e map[string]string) {
			e["FEATURE_ROOM_AUTH"] = "false"
			e["ROOM_AUTH_SECRET"] = "short"
		}, ""},
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

// #319: REPORT_RETENTION_DAYS. Unset or 0 keeps forever (the default, an owner
// decision); anything that is not a whole number of days in range is an error
// rather than a silent keep-forever, because a retention promise the server
// does not keep is worse than none.
func TestReportRetention(t *testing.T) {
	tests := []struct {
		raw     string
		want    time.Duration
		wantErr bool
	}{
		{"", 0, false},
		{"0", 0, false},
		{" 30 ", 30 * 24 * time.Hour, false},
		{"365", 365 * 24 * time.Hour, false},
		{"-1", 0, true},
		{"30d", 0, true},
		{"1.5", 0, true},
		{"36501", 0, true}, // above the cap
	}
	for _, tt := range tests {
		got, err := reportRetention(func(k string) string {
			if k == "REPORT_RETENTION_DAYS" {
				return tt.raw
			}
			return ""
		})
		if (err != nil) != tt.wantErr {
			t.Fatalf("reportRetention(%q) err = %v, wantErr %v", tt.raw, err, tt.wantErr)
		}
		if got != tt.want {
			t.Fatalf("reportRetention(%q) = %v, want %v", tt.raw, got, tt.want)
		}
	}
}

func TestValidateProdConfig_InvalidReportRetentionIsFatal(t *testing.T) {
	env := validProd()
	env["REPORT_RETENTION_DAYS"] = "thirty"

	fatal, _ := validateProdConfig(func(k string) string { return env[k] })

	if !strings.Contains(strings.Join(fatal, "\n"), "REPORT_RETENTION_DAYS") {
		t.Fatalf("expected a fatal REPORT_RETENTION_DAYS problem, got %v", fatal)
	}
}

// Keep-forever is legal but must be visible: a production boot without
// retention configured warns, it does not refuse.
func TestValidateProdConfig_RetentionUnsetWarns(t *testing.T) {
	keys := []string{"REPORT_RETENTION_DAYS", "ROOM_PERSIST_IDLE_TTL_MINUTES"}
	env := validProd()

	fatal, warn := validateProdConfig(func(k string) string { return env[k] })
	if len(fatal) > 0 {
		t.Fatalf("unset retention must not be fatal, got %v", fatal)
	}
	joined := strings.Join(warn, "\n")
	for _, key := range keys {
		if !strings.Contains(joined, key) {
			t.Fatalf("expected a %s warning, got %v", key, warn)
		}
	}

	// An explicit 0 is the same keep-forever and must warn the same way.
	env[keys[0]] = "0"
	env[keys[1]] = "0"
	_, warn = validateProdConfig(func(k string) string { return env[k] })
	joined = strings.Join(warn, "\n")
	for _, key := range keys {
		if !strings.Contains(joined, key) {
			t.Fatalf("explicit 0 must warn for %s, got %v", key, warn)
		}
	}

	env[keys[0]] = "365"
	env[keys[1]] = "43200"
	_, warn = validateProdConfig(func(k string) string { return env[k] })
	joined = strings.Join(warn, "\n")
	for _, key := range keys {
		if strings.Contains(joined, key) {
			t.Fatalf("configured %s must not warn, got %v", key, warn)
		}
	}
}
