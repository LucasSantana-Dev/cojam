package report

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"
)

// A stored report nobody reads is the same as no reporting route (spec 3.2).
// The webhook is the push half: when REPORT_WEBHOOK_URL is set, each new report
// posts a minimal summary to the operator's channel. It is deliberately thin:
// no chat content, no names, no reporter identity. The channel the operator
// uses (Slack, Discord, ntfy, a mail bridge) is a retention surface of its own,
// so the payload carries only what is needed to decide whether to open the
// database. Room id is included because it is what the operator needs to act
// (kick, disable public); treat the destination as sensitive for that reason.

const (
	webhookTimeout  = 3 * time.Second
	webhookInflight = 8
)

// Categories a reporter can pick. Unknown values collapse to CategoryOther so
// the field can never carry free text into the webhook.
const (
	CategoryMinorAtRisk = "minor_at_risk"
	CategorySexual      = "sexual_content"
	CategoryHarassment  = "harassment"
	CategorySpam        = "spam"
	CategoryOther       = "other"
)

// NormalizeCategory maps c to a known category, defaulting to CategoryOther.
func NormalizeCategory(c string) string {
	switch c {
	case CategoryMinorAtRisk, CategorySexual, CategoryHarassment, CategorySpam:
		return c
	}
	return CategoryOther
}

// Notifier announces a freshly stored report. Implementations must not block
// the caller for long and must not return failures that should affect the
// report write: the report is already durable by the time this runs.
type Notifier interface {
	Notify(r Report, category string)
}

// WebhookPayload is the entire body posted to the webhook. Both "text" and
// "content" carry the same one-line summary so Slack-style and Discord-style
// endpoints render it without configuration.
type WebhookPayload struct {
	Text      string `json:"text"`
	Content   string `json:"content"`
	ReportID  string `json:"reportId"`
	Kind      string `json:"kind"`
	RoomID    string `json:"roomId"`
	Category  string `json:"category"`
	CreatedAt string `json:"createdAt"`
}

// WebhookNotifier posts report summaries to a URL, off the request path.
type WebhookNotifier struct {
	url    string
	client *http.Client
	logger *slog.Logger
	sem    chan struct{}
}

// NewWebhookNotifier returns a notifier for rawURL, or nil when rawURL is empty
// (feature off). A malformed or non-http(s) URL is an error so a typo in the
// environment is caught at startup rather than silently dropping reports.
func NewWebhookNotifier(rawURL string, logger *slog.Logger) (*WebhookNotifier, error) {
	if rawURL == "" {
		return nil, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("REPORT_WEBHOOK_URL must be an absolute http(s) URL")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &WebhookNotifier{
		url:    rawURL,
		client: &http.Client{Timeout: webhookTimeout},
		logger: logger,
		sem:    make(chan struct{}, webhookInflight),
	}, nil
}

// Notify posts asynchronously and never blocks or fails the caller. When too
// many posts are already in flight (a flood against a slow endpoint) the
// summary is dropped and logged; the report itself is already stored.
func (n *WebhookNotifier) Notify(r Report, category string) {
	select {
	case n.sem <- struct{}{}:
	default:
		n.logger.Warn("report_webhook_dropped", "report_id", r.ID, "reason", "too many in flight")
		return
	}
	go func() {
		defer func() { <-n.sem }()
		if err := n.post(r, category); err != nil {
			// The URL is not logged: webhook URLs commonly embed a secret.
			n.logger.Error("report_webhook_failed", "report_id", r.ID, "err", scrubURLErr(err))
		}
	}()
}

func (n *WebhookNotifier) post(r Report, category string) error {
	category = NormalizeCategory(category)
	summary := fmt.Sprintf("CoJam report %s: %s in room %s (%s)", r.ID, r.Kind, r.RoomID, category)
	body, err := json.Marshal(WebhookPayload{
		Text:      summary,
		Content:   summary,
		ReportID:  r.ID,
		Kind:      string(r.Kind),
		RoomID:    r.RoomID,
		Category:  category,
		CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), webhookTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}

// scrubURLErr drops the *url.Error wrapper, whose message embeds the full URL.
func scrubURLErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}
