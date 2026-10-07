package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

var reportIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Bounds for the report endpoint. It is an unauthenticated-ish public write
// (membership is not checkable over HTTP), so it is bounded like /api/telemetry.
const (
	reportMaxBody    = 16 << 10
	reportMaxContent = 500 // runes
	reportMaxReason  = 300 // runes
	reportBurst      = 5
	reportRefill     = 20 * time.Second
)

type reportRequest struct {
	RoomID    string `json:"roomId"`
	Kind      string `json:"kind"`
	SubjectID string `json:"subjectId"`
	// Content is the reporter's copy of what they are reporting. The server
	// cannot fetch it: chat is ephemeral and may already be gone.
	Content string `json:"content"`
	Reason  string `json:"reason"`
	// Category is a closed set (report.NormalizeCategory); it is the only
	// reporter-chosen field that reaches the webhook.
	Category  string `json:"category"`
	ConnToken string `json:"connToken"`
}

// reportHandler files one member report. Open to guests by design: requiring an
// account would exclude most of the people reporting exists to protect.
func reportHandler(
	store report.Store, roomAuthSecret string, metrics *obs.Metrics,
	logger *slog.Logger, limiter *callerLimiter, notifier report.Notifier,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.allow(callerKey(r), time.Now()) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}

		var req reportRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, reportMaxBody)).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		kind := report.Kind(req.Kind)
		// ids are short by construction; an oversize one is abuse, not a typo,
		// and would otherwise be stored verbatim (up to the body cap).
		// Ids reach the operator's webhook channel, so they are restricted to a
		// plain charset (no mentions, markdown or newlines). Real ids are
		// base36, base64url or uuid; subjectId may be empty (room reports).
		if !kind.Valid() || !reportIDRe.MatchString(req.RoomID) ||
			(req.SubjectID != "" && !reportIDRe.MatchString(req.SubjectID)) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Identity is recorded when available but never required: room auth may
		// be off, and a report from an unidentified member still matters.
		var sub string
		if roomAuthSecret != "" && req.ConnToken != "" {
			if s, err := connauth.Validate([]byte(roomAuthSecret), req.ConnToken); err == nil {
				sub = s
			}
		}

		// Postgres text rejects NUL, which would turn a hostile report into a
		// 500 and a lost report.
		req.Content = stripNUL(req.Content)
		req.Reason = stripNUL(req.Reason)

		category := report.NormalizeCategory(req.Category)
		reason := truncateRunes(req.Reason, reportMaxReason)
		if category != report.CategoryOther {
			// Stored with the report so the operator reading the table sees it.
			// Truncate first so the prefix does not eat the reporter's budget.
			reason = "[" + category + "] " + reason
		}

		rec := report.Report{
			ID:          connauth.NewSub(), // random id, same generator as anon subs
			RoomID:      req.RoomID,
			Kind:        kind,
			ReporterSub: sub,
			SubjectID:   req.SubjectID,
			Content:     truncateRunes(req.Content, reportMaxContent),
			Reason:      reason,
			CreatedAt:   time.Now().UTC(),
		}

		if err := store.Create(r.Context(), rec); err != nil {
			logger.Error("report_store_failed", "err", err.Error())
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		// Logged at warn so it surfaces in whatever reads the logs. Content is
		// deliberately not logged: it is already stored, and duplicating it into
		// stdout widens where reported material lives.
		metrics.ReportFiled(string(rec.Kind))
		logger.Warn("report_filed", "room_id", rec.RoomID, "kind", string(rec.Kind),
			"subject_id", rec.SubjectID, "has_reporter", sub != "")

		// Push to the operator after the write is durable. The notifier is
		// async and swallows its own failures: a dead webhook must never turn a
		// stored report into an error for the reporter.
		if notifier != nil {
			notifier.Notify(rec, category)
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func stripNUL(s string) string { return strings.ReplaceAll(s, "\x00", "") }
