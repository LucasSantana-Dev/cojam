package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

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
	Content   string `json:"content"`
	Reason    string `json:"reason"`
	ConnToken string `json:"connToken"`
}

// reportHandler files one member report. Open to guests by design: requiring an
// account would exclude most of the people reporting exists to protect.
func reportHandler(
	store report.Store, roomAuthSecret string, metrics *obs.Metrics,
	logger *slog.Logger, limiter *callerLimiter,
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
		if req.RoomID == "" || !kind.Valid() {
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

		rec := report.Report{
			ID:          connauth.NewSub(), // random id, same generator as anon subs
			RoomID:      req.RoomID,
			Kind:        kind,
			ReporterSub: sub,
			SubjectID:   req.SubjectID,
			Content:     truncateRunes(req.Content, reportMaxContent),
			Reason:      truncateRunes(req.Reason, reportMaxReason),
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

		w.WriteHeader(http.StatusNoContent)
	}
}
