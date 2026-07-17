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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/LucasSantana-Dev/cojam/server/internal/appletoken"
	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/lyrics"
	"github.com/LucasSantana-Dev/cojam/server/internal/match"
	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/playlist"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
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

// parseOrigins turns a comma-separated CORS_ORIGINS value into a lookup set.
// Empty input defaults to local dev origins so `pnpm dev` works out of the box.
func parseOrigins(raw string) map[string]bool {
	set := make(map[string]bool)
	if strings.TrimSpace(raw) == "" {
		set["http://localhost:3000"] = true
		set["http://127.0.0.1:3000"] = true
		return set
	}
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			set[o] = true
		}
	}
	return set
}

func main() {
	var shutdownHooks []func()

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

	// Wire persistent store if DATABASE_URL is configured. dbPool is held at this
	// scope so the /readyz check can ping it; nil in in-memory mode.
	var dbPool *pgxpool.Pool
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		// Bound all startup DB work (connect, ping, migrate) with a deadline so a
		// hung or locked database fails the deploy fast instead of blocking forever.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		// Runtime pool uses DATABASE_URL (typically the hosted provider's pooled URL).
		pool, err := db.Open(ctx, dbURL)
		if err != nil {
			log.Fatalf("failed to open database: %v", err)
		}

		// Migrate via DIRECT_DATABASE_URL when provided: hosted Postgres poolers can
		// restrict DDL, and the direct connection sidesteps that. Falls back to the
		// runtime pool when no direct URL is set.
		if direct := os.Getenv("DIRECT_DATABASE_URL"); direct != "" {
			migratePool, err := db.Open(ctx, direct)
			if err != nil {
				pool.Close()
				log.Fatalf("failed to open DIRECT_DATABASE_URL for migration: %v", err)
			}
			err = db.Migrate(ctx, migratePool)
			migratePool.Close()
			if err != nil {
				pool.Close()
				log.Fatalf("failed to migrate database: %v", err)
			}
		} else if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			log.Fatalf("failed to migrate database: %v", err)
		}

		dbPool = pool
		pgStore := store.NewPostgres(pool)
		h.WithStore(pgStore)
		logger.Info("persistence_enabled", "store", "postgres")

		// Schedule pool close on shutdown
		shutdownHooks = append(shutdownHooks, func() {
			pool.Close()
		})
	} else {
		logger.Info("persistence_disabled", "store", "memory", "hint", "set DATABASE_URL to persist rooms")
	}
	if featureEnabled("FEATURE_MATCHING", true) && os.Getenv("YOUTUBE_API_KEY") != "" {
		cachedMatcher := match.NewCachedMatcher(match.ResolveYouTube, func(hit bool) {
			if hit {
				if metrics != nil {
					metrics.MatchCacheHit()
				}
				logger.Info("match_cache", "hit", true)
			} else {
				if metrics != nil {
					metrics.MatchCacheMiss()
				}
				logger.Info("match_cache", "hit", false)
			}
		})
		h.WithMatcher(cachedMatcher)
		logger.Info("matcher_enabled", "provider", "youtube")
	} else {

		// Wire Spotify matcher if configured
		if featureEnabled("FEATURE_MATCHING", true) && os.Getenv("SPOTIFY_CLIENT_ID") != "" && os.Getenv("SPOTIFY_CLIENT_SECRET") != "" {
			spotifyCachedMatcher := match.NewCachedMatcher(match.ResolveSpotify, func(hit bool) {
				if hit {
					if metrics != nil {
						metrics.MatchCacheHit()
					}
					logger.Info("spotify_match_cache", "hit", true)
				} else {
					if metrics != nil {
						metrics.MatchCacheMiss()
					}
					logger.Info("spotify_match_cache", "hit", false)
				}
			})
			h.WithSpotifyMatcher(spotifyCachedMatcher)
			logger.Info("spotify_matcher_enabled", "provider", "spotify")
		} else {
			logger.Info("spotify_matcher_disabled", "feature", featureEnabled("FEATURE_MATCHING", true), "has_id", os.Getenv("SPOTIFY_CLIENT_ID") != "", "has_secret", os.Getenv("SPOTIFY_CLIENT_SECRET") != "")
		}
		logger.Info("matcher_disabled", "feature", featureEnabled("FEATURE_MATCHING", true), "has_key", os.Getenv("YOUTUBE_API_KEY") != "")
	}

	// Independent providers below are gated only by their own feature flags and
	// wired regardless of which matcher (YouTube/Spotify/none) is configured above.

	// Wire aggregated search (Deezer + Spotify) whenever FEATURE_MATCHING is on
	// Deezer needs no credentials and is always available
	if featureEnabled("FEATURE_MATCHING", true) {
		h.WithSearcher(func(ctx context.Context, query string, limit int) ([]hub.SearchResult, error) {
			candidates, err := match.SearchAll(ctx, query, limit)
			if err != nil {
				return nil, err
			}
			results := make([]hub.SearchResult, len(candidates))
			for i, c := range candidates {
				results[i] = hub.SearchResult{
					Title:      c.Title,
					Artist:     c.Artist,
					Source:     c.Source,
					SpotifyURI: c.SpotifyURI,
					ISRC:       c.ISRC,
					DurationMs: c.DurationMs,
					ArtworkURL: c.ArtworkURL,
				}
			}
			return results, nil
		})
		logger.Info("searcher_enabled", "provider", "aggregated(deezer+spotify)")
	}

	// Wire playlist fetcher for playlist import
	if featureEnabled("FEATURE_PLAYLIST_IMPORT", true) {
		h.WithPlaylistFetcher(func(ctx context.Context, url string) ([]queue.TrackRef, error) {
			return playlist.FetchPlaylist(ctx, url)
		})
		logger.Info("playlist_fetcher_enabled")
	} else {
		logger.Info("playlist_fetcher_disabled")
	}

	// Wire radio auto-refill (Last.fm) when feature is on
	if featureEnabled("FEATURE_RADIO", true) && os.Getenv("LASTFM_API_KEY") != "" {
		h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
			return match.SimilarTracks(ctx, artist, title, limit)
		})
		logger.Info("radio_enabled", "provider", "lastfm")
	} else if featureEnabled("FEATURE_RADIO", true) {
		logger.Info("radio_feature_enabled_but_lastfm_unconfigured", "hint", "set LASTFM_API_KEY to enable")
	}

	// Wire track depth (MusicBrainz) when feature is on
	if featureEnabled("FEATURE_TRACK_DEPTH", true) {
		h.WithTrackDepthProvider(func(ctx context.Context, isrc, title, artist string) (interface{}, error) {
			return match.FetchTrackDepth(ctx, isrc, title, artist)
		})
		logger.Info("track_depth_enabled", "provider", "musicbrainz")
	}

	// Wire lyrics (LRCLIB) when feature is on
	if featureEnabled("FEATURE_LYRICS", true) {
		fetchLyrics := lyrics.NewCachedLyricsFetcher(lyrics.FetchLyrics)
		h.WithLyricsProvider(func(ctx context.Context, artist, title, album string, durationMs int) (interface{}, error) {
			return fetchLyrics(ctx, artist, title, album, durationMs)
		})
		logger.Info("lyrics_enabled", "provider", "lrclib")
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
			h.Leave(client.ID()) // revoke room memberships for this connection
			logger.Info("client_disconnected", "client_id", client.ID(), "reason", e.Reason)
		})

		client.OnSubscribe(func(e centrifuge.SubscribeEvent, cb centrifuge.SubscribeCallback) {
			logger.Info("channel_subscribed", "client_id", client.ID(), "channel", e.Channel)
			// Subscribing to room:<id> enrolls the client so it may mutate that room.
			// centrifuge re-subscribes on reconnect, so membership survives reconnects.
			if roomID, ok := strings.CutPrefix(e.Channel, "room:"); ok {
				h.Join(client.ID(), roomID)
			}
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

	// Liveness: the process is up. Readiness (/readyz) additionally gates on the
	// database when one is configured, so a deploy does not take traffic until the
	// store it needs is reachable.
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	r.Get("/readyz", readyzHandler(dbPool))

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

	// WebSocket handler for centrifuge. Origin allowlist prevents cross-site
	// WebSocket hijacking: without it any page could open a socket and mutate rooms.
	// CORS_ORIGINS is a comma-separated allowlist; unset defaults to local dev;
	// "*" explicitly opts into allow-all (dev/testing only, never production).
	allowedOrigins := parseOrigins(os.Getenv("CORS_ORIGINS"))
	wsHandler := centrifuge.NewWebsocketHandler(node, centrifuge.WebsocketConfig{
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true // non-browser client (native app, curl) — no Origin header
			}
			if allowedOrigins["*"] {
				return true
			}
			return allowedOrigins[origin]
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

	// Call registered shutdown hooks (e.g. pool.Close() for database)
	for _, hook := range shutdownHooks {
		hook()
	}

	log.Println("Server stopped")
}

// readyzHandler reports readiness. In memory mode (nil pool) the server is always
// ready. In Postgres mode it is ready only when the pool answers a ping within a
// short deadline, so a load balancer stops routing to an instance that has lost
// its database.
func readyzHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if pool != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := pool.Ping(ctx); err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "db": "unreachable"})
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	}
}
