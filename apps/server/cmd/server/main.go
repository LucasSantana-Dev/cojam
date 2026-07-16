package main

import (
	"context"
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/centrifugal/centrifuge"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/LucasSantana-Dev/music-jam/server/internal/appletoken"
	"github.com/LucasSantana-Dev/music-jam/server/internal/hub"
	"github.com/LucasSantana-Dev/music-jam/server/internal/match"
	"github.com/LucasSantana-Dev/music-jam/server/internal/obs"
)

// featureEnabled reads a FEATURE_* toggle (1/true/on/yes = on, 0/false/off/no = off,
// unset/unrecognized = dflt). Mirrors the web lib/features.ts convention.
func featureEnabled(key string, dflt bool) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "on", "yes":
		return true
	case "0", "false", "off", "no":
		return false
	default:
		return dflt
	}
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	metrics := obs.New()

	// Create centrifuge node
	node, err := centrifuge.New(centrifuge.Config{
		LogLevel: centrifuge.LogLevelInfo,
		LogHandler: func(e centrifuge.LogEntry) {
			logger.Info("centrifuge", "level", int(e.Level), "msg", e.Message, "fields", e.Fields)
		},
	})
	if err != nil {
		log.Fatalf("failed to create centrifuge node: %v", err)
	}

	// Start node
	if err := node.Run(); err != nil {
		log.Fatalf("failed to run centrifuge node: %v", err)
	}

	// Create hub
	h := hub.NewHub(node).WithObservability(logger, metrics)
	if featureEnabled("FEATURE_MATCHING", true) && os.Getenv("YOUTUBE_API_KEY") != "" {
		h.WithMatcher(match.ResolveYouTube)
		logger.Info("matcher_enabled", "provider", "youtube")
	} else {
		logger.Info("matcher_disabled", "feature", featureEnabled("FEATURE_MATCHING", true), "has_key", os.Getenv("YOUTUBE_API_KEY") != "")
	}

	// Setup centrifuge connection handlers
	node.OnConnecting(func(ctx context.Context, e centrifuge.ConnectEvent) (centrifuge.ConnectReply, error) {
		// Allow anonymous connections (no auth v0) — empty UserID marks the client anonymous,
		// but Credentials must be present or centrifuge rejects the connect with "bad request".
		// The display name arrives as connect data {name}; carry it as ConnInfo so presence
		// entries show who is in the room (metadata only — no audio, no auth).
		var info []byte
		if len(e.Data) > 0 {
			var d struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(e.Data, &d) == nil && d.Name != "" {
				info, _ = json.Marshal(map[string]string{"name": d.Name})
			}
		}
		return centrifuge.ConnectReply{
			Credentials: &centrifuge.Credentials{UserID: "", Info: info},
		}, nil
	})

	node.OnConnect(func(client *centrifuge.Client) {
		metrics.ConnInc()
		logger.Info("client_connected", "client_id", client.ID(), "transport", client.Transport().Name())

		// Room routing happens per-RPC via params.roomId (docs/protocol.md)
		h.RegisterClient(client)

		client.OnDisconnect(func(e centrifuge.DisconnectEvent) {
			metrics.ConnDec()
			logger.Info("client_disconnected", "client_id", client.ID(), "reason", e.Reason)
		})

		client.OnSubscribe(func(e centrifuge.SubscribeEvent, cb centrifuge.SubscribeCallback) {
			logger.Info("channel_subscribed", "client_id", client.ID(), "channel", e.Channel)
			// Presence + join/leave so the room can show who is listening.
			cb(centrifuge.SubscribeReply{
				Options: centrifuge.SubscribeOptions{
					EmitPresence:  true,
					EmitJoinLeave: true,
					PushJoinLeave: true,
				},
			}, nil)
		})

		// Authorize presence queries (else client presence() returns code 108).
		client.OnPresence(func(e centrifuge.PresenceEvent, cb centrifuge.PresenceCallback) {
			cb(centrifuge.PresenceReply{}, nil)
		})
	})

	// Create chi router
	r := chi.NewRouter()

	// Add middleware
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Health check endpoint
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// Apple token endpoint
	r.Get("/api/apple/dev-token", func(w http.ResponseWriter, r *http.Request) {
		token, err := appletoken.BuildToken()
		if err == appletoken.ErrNotConfigured {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotImplemented)
			json.NewEncoder(w).Encode(map[string]string{"error": "apple credentials not configured"})
			return
		}
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"token": token})
	})

	// WebSocket handler for centrifuge
	wsHandler := centrifuge.NewWebsocketHandler(node, centrifuge.WebsocketConfig{
		CheckOrigin: func(r *http.Request) bool {
			// Allow all origins for now; restrict in production
			return true
		},
	})
	r.Handle("/connection/websocket", wsHandler)

	// Prometheus metrics (custom registry from obs)
	r.Handle("/metrics", promhttp.HandlerFor(metrics.Registry, promhttp.HandlerOpts{}))

	// HTTP server setup
	server := &http.Server{
		Addr:    ":8080",
		Handler: r,
	}

	log.Println("Starting server on :8080")

	// Start server in a goroutine
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}

	// Shutdown centrifuge node
	if err := node.Shutdown(ctx); err != nil {
		log.Printf("node shutdown error: %v", err)
	}

	log.Println("Server stopped")
}
