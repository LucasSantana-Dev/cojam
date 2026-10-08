package hub

import (
	"encoding/json"
	"fmt"
	"sync"
)

// Listening service per member ("Ouvir no"). The platform in the connect-time
// ConnInfo is fixed per connection, and reconnecting to change it would run
// the host handoff (PromoteOnDisconnect), so a change goes through
// member.set_platform instead: the server stores it per connection, publishes
// a member.platform event on the room channel and serves the current map to
// late joiners through member.platforms. Metadata only, like the ConnInfo one.

// validPlatform mirrors the values presenceConnInfo accepts.
func validPlatform(p string) bool {
	return p == "spotify" || p == "apple" || p == "youtube"
}

// platformStore holds clientID -> platform overrides. Zero value is ready.
type platformStore struct {
	mu sync.RWMutex
	m  map[string]string
}

func (s *platformStore) set(clientID, platform string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = make(map[string]string)
	}
	s.m[clientID] = platform
}

func (s *platformStore) remove(clientID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, clientID)
}

func (s *platformStore) get(clientID string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.m[clientID]
	return p, ok
}

// memberSetPlatform handles member.set_platform: the caller must be a member of
// the room (Authorize enforces it at the transport; re-checked here for the
// transport-independent path) and the platform one of spotify|apple|youtube.
func (h *Hub) memberSetPlatform(roomID, platform, clientID string) (json.RawMessage, error) {
	if clientID == "" || !h.IsMember(clientID, roomID) {
		return nil, userErrorf("not a member of this room")
	}
	if !validPlatform(platform) {
		return nil, userErrorf("platform must be spotify, apple or youtube")
	}
	h.platforms.set(clientID, platform)
	if err := h.publishPlatform(roomID, clientID, platform); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]string{"clientId": clientID, "platform": platform})
}

// memberPlatforms handles member.platforms: the overrides of the room's current
// members, so a late joiner can overlay them on the presence seed.
func (h *Hub) memberPlatforms(roomID string) (json.RawMessage, error) {
	h.memberMu.RLock()
	ids := make([]string, 0, len(h.roomMembers[roomID]))
	for id := range h.roomMembers[roomID] {
		ids = append(ids, id)
	}
	h.memberMu.RUnlock()
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		if p, ok := h.platforms.get(id); ok {
			out[id] = p
		}
	}
	return json.Marshal(map[string]map[string]string{"platforms": out})
}

// publishPlatform broadcasts one member.platform event on the room channel.
// A nil node (tests) skips, like publishChat.
func (h *Hub) publishPlatform(roomID, clientID, platform string) error {
	if h.node == nil {
		return nil
	}
	payload, err := json.Marshal(map[string]string{
		"type":     "member.platform",
		"clientId": clientID,
		"platform": platform,
	})
	if err != nil {
		return err
	}
	if _, err = h.node.Publish("room:"+roomID, payload); err != nil {
		if h.metrics != nil {
			h.metrics.PublishError()
		}
		return fmt.Errorf("publish member.platform: %w", err)
	}
	return nil
}
