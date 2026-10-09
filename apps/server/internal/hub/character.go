package hub

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sync"
)

// Audience character per member ("Modo palco"). A fixed roster of 14; repeats
// are allowed. Like the listening service, the choice is changeable without a
// reconnect (a reconnect would run the host handoff): member.set_character
// stores it per connection, publishes a member.character event on the room
// channel and member.characters serves the current map to late joiners.
// Metadata only: an id, never an image or a free string.

// CharacterCount is the size of the roster; valid ids are 1..CharacterCount.
const CharacterCount = 14

// DefaultCharacterPool is the modulus of the default hash. It stays 12 so no
// existing default changed when characters 13 and 14 joined: they are
// pickable, never a default. Web twin: CHARACTER_DEFAULT_POOL in packages/shared.
const DefaultCharacterPool = 12

// validCharacter reports whether id is a roster id.
func validCharacter(id int) bool {
	return id >= 1 && id <= CharacterCount
}

// DefaultCharacter is the character a member who never chose is shown with:
// FNV-1a (32 bit) of the userID bytes, mod DefaultCharacterPool, plus 1. The web
// client implements the same function (lib/characters.ts); both are pinned by
// the same test vectors so every viewer draws the same person.
func DefaultCharacter(userID string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(userID))
	return int(h.Sum32()%DefaultCharacterPool) + 1
}

// characterStore holds clientID -> character overrides. Zero value is ready.
type characterStore struct {
	mu sync.RWMutex
	m  map[string]int
}

func (s *characterStore) set(clientID string, id int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = make(map[string]int)
	}
	s.m[clientID] = id
}

func (s *characterStore) remove(clientID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, clientID)
}

func (s *characterStore) get(clientID string) (int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.m[clientID]
	return id, ok
}

// memberSetCharacter handles member.set_character: the caller must be a member
// of the room (Authorize enforces it at the transport; re-checked here for the
// transport-independent path) and the id within the roster.
func (h *Hub) memberSetCharacter(roomID string, characterID int, clientID string) (json.RawMessage, error) {
	if clientID == "" || !h.IsMember(clientID, roomID) {
		return nil, userErrorf("not a member of this room")
	}
	if !validCharacter(characterID) {
		return nil, userErrorf("characterId must be between 1 and %d", CharacterCount)
	}
	h.characters.set(clientID, characterID)
	if err := h.publishCharacter(roomID, clientID, characterID); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"clientId": clientID, "characterId": characterID})
}

// memberCharacters handles member.characters: the overrides of the room's
// current members, so a late joiner can overlay them on the presence seed.
func (h *Hub) memberCharacters(roomID string) (json.RawMessage, error) {
	h.memberMu.RLock()
	ids := make([]string, 0, len(h.roomMembers[roomID]))
	for id := range h.roomMembers[roomID] {
		ids = append(ids, id)
	}
	h.memberMu.RUnlock()
	out := make(map[string]int, len(ids))
	for _, id := range ids {
		if c, ok := h.characters.get(id); ok {
			out[id] = c
		}
	}
	return json.Marshal(map[string]map[string]int{"characters": out})
}

// publishCharacter broadcasts one member.character event on the room channel.
// A nil node (tests) skips, like publishPlatform.
func (h *Hub) publishCharacter(roomID, clientID string, characterID int) error {
	if h.node == nil {
		return nil
	}
	payload, err := json.Marshal(map[string]any{
		"type":        "member.character",
		"clientId":    clientID,
		"characterId": characterID,
	})
	if err != nil {
		return err
	}
	if _, err = h.node.Publish("room:"+roomID, payload); err != nil {
		if h.metrics != nil {
			h.metrics.PublishError()
		}
		return fmt.Errorf("publish member.character: %w", err)
	}
	return nil
}
