package hub

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// setupHandoffRoom creates a room hosted by hostClient/hostUser with the
// given members (clientID -> userID; an empty userID is a guest and gets no
// identity record) and explicit join times (userID -> unix nanos) so
// seniority is deterministic.
func setupHandoffRoom(t *testing.T, h *Hub, roomID, hostClient, hostUser string, members map[string]string, joinTimes map[string]int64) *Room {
	t.Helper()
	room := mustRoom(t, h, roomID)
	room.mu.Lock()
	room.State.HostUserID = hostUser
	room.mu.Unlock()
	h.RecordClientUserID(hostClient, hostUser)
	h.Join(hostClient, roomID)
	for clientID, userID := range members {
		h.RecordClientUserID(clientID, userID)
		h.Join(clientID, roomID)
	}
	if joinTimes != nil {
		h.memberMu.Lock()
		h.memberJoinTimes[roomID] = joinTimes
		h.memberMu.Unlock()
	}
	return room
}

// roomVersion reads the room's state under its lock.
func roomState(room *Room) (host string, version int64) {
	room.mu.Lock()
	defer room.mu.Unlock()
	return room.State.HostUserID, room.State.Version
}

// #166: a host disconnect promotes the longest-present remaining
// authenticated member, bumps Version exactly once, and the new host is
// persisted + published through the standard mutate path.
func TestPromoteOnDisconnect_PromotesLongestPresent(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a", "c-b": "u-b"},
		map[string]int64{"u-a": 100, "u-b": 200})
	_, versionBefore := roomState(room)

	h.PromoteOnDisconnect("c-host")

	host, version := roomState(room)
	if host != "u-a" {
		t.Fatalf("HostUserID = %q, want u-a (earliest join)", host)
	}
	if version != versionBefore+1 {
		t.Fatalf("Version = %d, want exactly one bump from %d", version, versionBefore)
	}

	// The promotion went through mutate, so it was persisted too.
	stored, err := h.store.Load(context.Background(), "room")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.HostUserID != "u-a" {
		t.Fatalf("persisted HostUserID = %q, want u-a", stored.HostUserID)
	}
}

// #166: a host disconnecting from a room with no other members must not
// error, mutate, or bump Version; the room stays reclaimable.
func TestPromoteOnDisconnect_EmptyRoom(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host", nil, nil)
	_, versionBefore := roomState(room)

	h.PromoteOnDisconnect("c-host")

	host, version := roomState(room)
	if host != "u-host" || version != versionBefore {
		t.Fatalf("empty room must not mutate: host = %q, version %d -> %d", host, versionBefore, version)
	}
}

// #166: with only guests remaining, HostUserID is cleared (restoring
// equal-member behavior) rather than left dangling at the departed host.
func TestPromoteOnDisconnect_AllGuestRoomClearsHost(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-g1": "", "c-g2": ""}, nil)
	_, versionBefore := roomState(room)

	h.PromoteOnDisconnect("c-host")

	host, version := roomState(room)
	if host != "" {
		t.Fatalf("all-guest room HostUserID = %q, want cleared", host)
	}
	if version != versionBefore+1 {
		t.Fatalf("Version = %d, want exactly one bump from %d", version, versionBefore)
	}
}

// #166: a non-host disconnect changes nothing.
func TestPromoteOnDisconnect_NonHostIsNoop(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a"}, map[string]int64{"u-a": 100})
	_, versionBefore := roomState(room)

	h.PromoteOnDisconnect("c-a")

	host, version := roomState(room)
	if host != "u-host" || version != versionBefore {
		t.Fatalf("non-host disconnect must not mutate: host = %q, version %d -> %d", host, versionBefore, version)
	}
}

// #166: a guest disconnect short-circuits on the empty userID.
func TestPromoteOnDisconnect_GuestIsNoop(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-g1": ""}, nil)
	_, versionBefore := roomState(room)

	h.PromoteOnDisconnect("c-g1")

	host, version := roomState(room)
	if host != "u-host" || version != versionBefore {
		t.Fatalf("guest disconnect must not mutate: host = %q, version %d -> %d", host, versionBefore, version)
	}
}

// #166: a rejoin resets seniority — promotion measures continuous presence,
// not cumulative history.
func TestPromoteOnDisconnect_ReconnectResetsSeniority(t *testing.T) {
	h := NewHub(nil)
	// u-a joined first, u-b second, then u-a reconnected: u-b is now the
	// longest continuously present member.
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a", "c-b": "u-b"},
		map[string]int64{"u-a": 300, "u-b": 200})

	h.PromoteOnDisconnect("c-host")

	host, _ := roomState(room)
	if host != "u-b" {
		t.Fatalf("HostUserID = %q, want u-b (u-a reconnected and lost seniority)", host)
	}
}

// #166: room.join stamps the authenticated joiner's presence, and a rejoin
// overwrites a stale timestamp.
func TestRoomJoinRecordsJoinTime(t *testing.T) {
	h := NewHub(nil)
	payload := []byte(`{"roomId":"room","name":"a"}`)
	if _, err := h.HandleRPC("room.join", payload, "u-a"); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	h.memberMu.RLock()
	first := h.memberJoinTimes["room"]["u-a"]
	h.memberMu.RUnlock()
	if first == 0 {
		t.Fatal("room.join must record the authenticated join time")
	}

	h.memberMu.Lock()
	h.memberJoinTimes["room"]["u-a"] = 1 // stale
	h.memberMu.Unlock()
	if _, err := h.HandleRPC("room.join", payload, "u-a"); err != nil {
		t.Fatalf("room.join (rejoin): %v", err)
	}
	h.memberMu.RLock()
	second := h.memberJoinTimes["room"]["u-a"]
	h.memberMu.RUnlock()
	if second <= 1 {
		t.Fatalf("rejoin must reset the join timestamp, got %d", second)
	}
}

// #166: anonymous joins (FEATURE_ROOM_AUTH off) record nothing.
func TestRoomJoinAnonymousRecordsNoJoinTime(t *testing.T) {
	h := NewHub(nil)
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"room","name":"a"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	h.memberMu.RLock()
	_, ok := h.memberJoinTimes["room"]
	h.memberMu.RUnlock()
	if ok {
		t.Fatal("anonymous join must not record a join time")
	}
}

// #166: the same disconnect processed concurrently produces exactly one
// promotion — the mutate closure re-checks HostUserID, so losers are no-ops.
func TestPromoteOnDisconnect_ConcurrentSinglePromotion(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a", "c-b": "u-b"},
		map[string]int64{"u-a": 100, "u-b": 200})
	_, versionBefore := roomState(room)

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			h.PromoteOnDisconnect("c-host")
		}()
	}
	close(start)
	wg.Wait()

	host, version := roomState(room)
	if host != "u-a" {
		t.Fatalf("HostUserID = %q, want u-a", host)
	}
	if version != versionBefore+1 {
		t.Fatalf("concurrent disconnects must bump Version exactly once: %d -> %d", versionBefore, version)
	}
}

// #166: the host and the selected successor disconnect together. The
// commit-time revalidation aborts the stale promotion, so the departed
// successor is never persisted as HostUserID.
func TestPromoteOnDisconnect_SuccessorGoneAtCommit(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a", "c-b": "u-b"},
		map[string]int64{"u-b": 50, "u-a": 100}) // u-b is the selected successor
	_, versionBefore := roomState(room)

	successor, others := h.selectSuccessor("room", "c-host")
	if !others || successor != "u-b" {
		t.Fatalf("selectSuccessor = %q, %v; want u-b, true", successor, others)
	}

	// The successor's disconnect cleanup lands between selection and commit.
	h.Leave("c-b")
	h.RemoveClientUserID("c-b")

	h.commitHostHandoff("room", "u-host", successor)

	host, version := roomState(room)
	if host != "u-host" {
		t.Fatalf("stale promotion must abort: HostUserID = %q, want u-host", host)
	}
	if version != versionBefore {
		t.Fatalf("aborted promotion must not bump Version: %d -> %d", versionBefore, version)
	}

	// Nothing stale reached the store either.
	stored, err := h.store.Load(context.Background(), "room")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.HostUserID == "u-b" {
		t.Fatal("departed successor must never be persisted as host")
	}
}

// #166: the successor's full disconnect hook running before the host's
// promotion means selection never sees the departed member; the next
// longest-present member is promoted instead.
func TestPromoteOnDisconnect_SuccessorDisconnectedFirst(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a", "c-b": "u-b"},
		map[string]int64{"u-b": 50, "u-a": 100})

	// u-b's disconnect hook runs to completion first (its promote is a no-op:
	// u-b is not host), then the host's hook promotes u-a.
	h.PromoteOnDisconnect("c-b")
	h.Leave("c-b")
	h.RemoveClientUserID("c-b")
	h.PromoteOnDisconnect("c-host")

	host, _ := roomState(room)
	if host != "u-a" {
		t.Fatalf("HostUserID = %q, want u-a", host)
	}
}

// #166: the host and the selected successor disconnecting simultaneously
// never crashes and never splits the room — run under -race. Any final host
// the promotions leave behind is either a present member or the pre-handoff
// host (the lazy reclaim in room.join is the safety net for the interleave
// where the successor's hook ran before it became host).
func TestPromoteOnDisconnect_ConcurrentHostAndSuccessor(t *testing.T) {
	for i := 0; i < 100; i++ {
		h := NewHub(nil)
		room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
			map[string]string{"c-a": "u-a", "c-b": "u-b"},
			map[string]int64{"u-b": 50, "u-a": 100})

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.PromoteOnDisconnect("c-host")
			h.Leave("c-host")
			h.RemoveClientUserID("c-host")
		}()
		go func() {
			defer wg.Done()
			h.PromoteOnDisconnect("c-b")
			h.Leave("c-b")
			h.RemoveClientUserID("c-b")
		}()
		wg.Wait()

		host, _ := roomState(room)
		switch host {
		case "u-host", "u-a", "u-b":
			// u-b is possible only when its commit legitimately preceded its
			// own Leave; the next join's lazy reclaim fixes that interleave.
		default:
			t.Fatalf("iteration %d: unexpected HostUserID %q", i, host)
		}
	}
}

// #166: a promoted host disconnecting promotes the next member — the path
// chains correctly.
func TestPromoteOnDisconnect_ChainedPromotion(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a", "c-b": "u-b"},
		map[string]int64{"u-a": 100, "u-b": 200})

	h.PromoteOnDisconnect("c-host")
	h.Leave("c-host")
	h.RemoveClientUserID("c-host")
	if host, _ := roomState(room); host != "u-a" {
		t.Fatalf("first handoff: HostUserID = %q, want u-a", host)
	}

	h.PromoteOnDisconnect("c-a")
	h.Leave("c-a")
	h.RemoveClientUserID("c-a")
	if host, _ := roomState(room); host != "u-b" {
		t.Fatalf("chained handoff: HostUserID = %q, want u-b", host)
	}
}

// #166: after a proactive promotion the new host is present, so the lazy
// reclaim in room.join evaluates false and does not double-promote.
func TestPromoteOnDisconnect_LazyReclaimIsNoopAfterPromotion(t *testing.T) {
	h := NewHub(nil)
	room := setupHandoffRoom(t, h, "room", "c-host", "u-host",
		map[string]string{"c-a": "u-a"}, map[string]int64{"u-a": 100})

	h.PromoteOnDisconnect("c-host")
	h.Leave("c-host")
	h.RemoveClientUserID("c-host")

	_, versionBefore := roomState(room)
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"room","name":"c"}`), "u-c"); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	host, version := roomState(room)
	if host != "u-a" {
		t.Fatalf("lazy reclaim must not override the promoted host: HostUserID = %q, want u-a", host)
	}
	if version != versionBefore {
		t.Fatalf("lazy reclaim must be a no-op: version %d -> %d", versionBefore, version)
	}
}

// #166: the room's join-time records die with the room when the in-memory
// evictor reaps it, so memberJoinTimes cannot leak.
func TestEvictIdleRoomsDeletesJoinTimes(t *testing.T) {
	h := NewHub(nil).WithRoomIdleTTL(time.Minute)
	room := mustRoom(t, h, "room")
	room.lastActivityUnix.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	h.memberMu.Lock()
	h.memberJoinTimes["room"] = map[string]int64{"u-a": 1}
	h.memberMu.Unlock()

	h.evictIdleRooms(time.Now())

	h.memberMu.RLock()
	_, ok := h.memberJoinTimes["room"]
	h.memberMu.RUnlock()
	if ok {
		t.Fatal("evicted room's join times must be deleted with it")
	}
}

// #166: concurrent joins, leaves, and disconnects against the promotion path
// — a race-detector smoke test, mirroring TestEvictIdleRoomsConcurrent.
func TestPromoteOnDisconnect_ConcurrentSmoke(t *testing.T) {
	h := NewHub(nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			clientID := fmt.Sprintf("client-%d", i)
			userID := fmt.Sprintf("user-%d", i)
			roomID := fmt.Sprintf("room-%d", i%2)
			for j := 0; j < 50; j++ {
				h.RecordClientUserID(clientID, userID)
				h.Join(clientID, roomID)
				if _, err := h.HandleRPC("room.join", []byte(fmt.Sprintf(`{"roomId":"%s","name":"x"}`, roomID)), userID); err != nil {
					t.Errorf("room.join: %v", err)
				}
				h.PromoteOnDisconnect(clientID)
				h.Leave(clientID)
				h.RemoveClientUserID(clientID)
			}
		}(i)
	}
	wg.Wait()
}
