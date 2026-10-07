package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// prodEnv is the APP_ENV value that turns on strict config validation.
const prodEnv = "production"

// minRoomAuthSecretLen is the shortest ROOM_AUTH_SECRET accepted in production.
// The secret is an HS256 HMAC key; 32 bytes matches the hash output size, so a
// shorter key is the weakest link in every connection token.
const minRoomAuthSecretLen = 32

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

	if featureEnabledIn(getenv, "FEATURE_ROOM_AUTH", false) {
		switch secret := getenv("ROOM_AUTH_SECRET"); {
		case secret == "":
			fatal = append(fatal, "FEATURE_ROOM_AUTH is on but ROOM_AUTH_SECRET is empty: every connection would be rejected")
		case len(secret) < minRoomAuthSecretLen:
			fatal = append(fatal, fmt.Sprintf("ROOM_AUTH_SECRET is shorter than %d bytes: connection tokens would be signed with a weak key", minRoomAuthSecretLen))
		}
	}

	if featureEnabledIn(getenv, "FEATURE_SUPABASE_AUTH", false) &&
		getenv("SUPABASE_URL") == "" && getenv("SUPABASE_JWT_SECRET") == "" {
		fatal = append(fatal, "FEATURE_SUPABASE_AUTH is on but neither SUPABASE_URL nor SUPABASE_JWT_SECRET is set: users would be unauthenticated")
	}

	// Retention (#319). An unparseable window is fatal: the operator meant to
	// set one, and silently keeping forever would make the privacy policy
	// false. Unset is a legitimate owner choice, so it only warns.
	if window, err := reportRetention(getenv); err != nil {
		fatal = append(fatal, err.Error())
	} else if window == 0 {
		warn = append(warn, "REPORT_RETENTION_DAYS is unset or 0: reports and moderation actions are kept indefinitely")
	}
	// Mirrors envDurationMinutes: unset, invalid or <= 0 all mean disabled.
	if n, err := strconv.Atoi(strings.TrimSpace(getenv("ROOM_PERSIST_IDLE_TTL_MINUTES"))); err != nil || n <= 0 {
		warn = append(warn, "ROOM_PERSIST_IDLE_TTL_MINUTES is unset or 0: persisted rooms (queue, votes, attribution) are kept indefinitely")
	}

	// Degraded, not broken: the server serves correctly with no metrics, it is
	// just blind. /readyz still reports green, which is the trap worth naming.
	if getenv("METRICS_ADDR") == "" {
		warn = append(warn, "METRICS_ADDR is unset: no Prometheus metrics are exported and /readyz stays green regardless")
	}

	return fatal, warn
}

// maxRetentionDays caps REPORT_RETENTION_DAYS at a century: anything longer is
// a typo, and the cap keeps the Duration far from overflow.
const maxRetentionDays = 36500

// reportRetention reads REPORT_RETENTION_DAYS (#319): how long reports and
// moderation actions are kept before the hourly purge deletes them. Unset or
// 0 means keep forever (the default; the window is an owner decision). Any
// other value must be a whole number of days in [1, maxRetentionDays].
func reportRetention(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv("REPORT_RETENTION_DAYS"))
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > maxRetentionDays {
		return 0, fmt.Errorf("REPORT_RETENTION_DAYS=%q is not a whole number of days between 0 and %d", raw, maxRetentionDays)
	}
	return time.Duration(n) * 24 * time.Hour, nil
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
