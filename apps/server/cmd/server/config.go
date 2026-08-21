package main

import (
	"fmt"
	"strings"
)

// prodEnv is the APP_ENV value that turns on strict config validation.
const prodEnv = "production"

// validateProdConfig returns the fatal misconfigurations for a production boot,
// and separately the non-fatal ones. Outside APP_ENV=production it returns
// nothing: local dev keeps the permissive defaults.
//
// Each fatal check covers a setting that otherwise fails silently at boot and
// only surfaces later as data loss or an open door.
func validateProdConfig(getenv func(string) string) (fatal, warn []string) {
	if !strings.EqualFold(getenv("APP_ENV"), prodEnv) {
		return nil, nil
	}

	if getenv("DATABASE_URL") == "" {
		fatal = append(fatal, "DATABASE_URL is unset: rooms would live in memory and vanish on every restart")
	}

	switch origins := strings.TrimSpace(getenv("CORS_ORIGINS")); {
	case origins == "":
		fatal = append(fatal, "CORS_ORIGINS is unset: the websocket origin allowlist would fall back to localhost")
	case strings.Contains(origins, "*"):
		fatal = append(fatal, `CORS_ORIGINS contains "*": any page could open a socket and mutate rooms`)
	}

	if featureEnabledIn(getenv, "FEATURE_ROOM_AUTH", false) && getenv("ROOM_AUTH_SECRET") == "" {
		fatal = append(fatal, "FEATURE_ROOM_AUTH is on but ROOM_AUTH_SECRET is empty: every connection would be rejected")
	}

	if featureEnabledIn(getenv, "FEATURE_SUPABASE_AUTH", false) &&
		getenv("SUPABASE_URL") == "" && getenv("SUPABASE_JWT_SECRET") == "" {
		fatal = append(fatal, "FEATURE_SUPABASE_AUTH is on but neither SUPABASE_URL nor SUPABASE_JWT_SECRET is set: users would be unauthenticated")
	}

	// Degraded, not broken: the server serves correctly with no metrics, it is
	// just blind. /readyz still reports green, which is the trap worth naming.
	if getenv("METRICS_ADDR") == "" {
		warn = append(warn, "METRICS_ADDR is unset: no Prometheus metrics are exported and /readyz stays green regardless")
	}

	return fatal, warn
}

// formatConfigErrors renders fatal problems as one multi-line message.
func formatConfigErrors(problems []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "refusing to start: %d production config problem(s)", len(problems))
	for _, p := range problems {
		fmt.Fprintf(&b, "\n  - %s", p)
	}
	return b.String()
}
