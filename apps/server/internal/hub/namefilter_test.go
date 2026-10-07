package hub

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestRoomNameBlocked_Blocks(t *testing.T) {
	for _, name := range []string{
		"porn", "PORN room", "Pornô", "sexo", "SEXO grátis",
		"p0rn", "s3x", "n00dz nudes", "nud3s",
		"p o r n", "p.o.r.n", "s e x o", "p-u-t-a",
		"puuuuta", "pooorno", "sexxxo",
		"pédófilo", "pedófilo club", "p3d0f1l0", "pedoph1le", "ped0philia",
		"estupro coletivo", "ESTUPRADOR", "est.u.pr0",
		"nigger", "n1gg3r", "n i g g e r", "f4ggot", "viado", "v1ado",
		"loli", "L0LI", "shota", "lolicon",
		"child porn", "crianca nua", "criança_nua", "menor nua",
		"hentai e nudes", "onlyfans",
		"pornografia", "xoxota", "bUcEtA", "punhet@",
		"musica e sexo", "​p​or​n",
	} {
		if !roomNameBlocked(name) {
			t.Errorf("expected %q to be blocked", name)
		}
	}
}

// Innocent names must survive; a false positive costs a host a rename but a
// filter that flags "Classic Rock" would be removed by the first annoyed user.
func TestRoomNameBlocked_AllowsInnocentNames(t *testing.T) {
	for _, name := range []string{
		"", "   ", "Lo-fi beats", "Classic Rock", "Sexta-feira do rock",
		"Sexta do Pagode", "Música Brasileira", "Sertanejo Universitário",
		"Scunthorpe FC", "Essex Radio", "Middlesex", "Analysis Club",
		"Cassino", "Pop 2000s", "Rolê dos amigos", "Pedro e Paulo",
		"Pedal sound", "Lolita Pop", "Shotgun Wedding Songs", "Rapper's Delight",
		"Putaro Jazz", "Arrasta pra cima", "Therapist chill", "Dickens Audio",
		"Coconut cocktail", "Titsias", "Spicy Salsa", "Fagundes Trio",
	} {
		if roomNameBlocked(name) {
			t.Errorf("expected %q to be allowed", name)
		}
	}
}

func setPublicNamed(roomID string, public bool, name string) []byte {
	b, _ := json.Marshal(map[string]any{"roomId": roomID, "public": public, "name": name})
	return b
}

func TestSetPublic_RejectsBlockedName(t *testing.T) {
	h := newPublicHub()
	h.Join("u", "r1")

	_, err := h.HandleRPC("room.set_public", setPublicNamed("r1", true, "p0rn nudes"), "u")
	if err == nil || !strings.Contains(err.Error(), errRoomNameNotAllowed) {
		t.Fatalf("expected %q, got %v", errRoomNameNotAllowed, err)
	}
	if rooms := listRooms(t, h, "u"); len(rooms) != 0 {
		t.Fatalf("a rejected name must not publish the room, got %+v", rooms)
	}
	room, _ := h.GetOrCreateRoom("r1")
	if room.State.Public || room.State.Name != "" {
		t.Fatalf("rejected rpc mutated state: %+v", room.State)
	}
}

// A rename of an already public room goes through the same RPC.
func TestSetPublic_RejectsBlockedRename(t *testing.T) {
	h := newPublicHub()
	h.Join("u", "r1")
	if _, err := h.HandleRPC("room.set_public", setPublicNamed("r1", true, "Lo-fi"), "u"); err != nil {
		t.Fatalf("clean name: %v", err)
	}
	_, err := h.HandleRPC("room.set_public", setPublicNamed("r1", true, "p u t a"), "u")
	if err == nil || !strings.Contains(err.Error(), errRoomNameNotAllowed) {
		t.Fatalf("expected rename rejection, got %v", err)
	}
	room, _ := h.GetOrCreateRoom("r1")
	if room.State.Name != "Lo-fi" {
		t.Fatalf("name changed despite rejection: %q", room.State.Name)
	}
}

// A room carrying a stored bad name cannot go public without a new name.
func TestSetPublic_RejectsStoredBlockedNameOnPublish(t *testing.T) {
	h := newPublicHub()
	h.Join("u", "r1")
	room, _ := h.GetOrCreateRoom("r1")
	room.mu.Lock()
	room.State.Name = "sexo"
	room.mu.Unlock()

	if _, err := h.HandleRPC("room.set_public", setPublicPayload("r1", true), "u"); err == nil {
		t.Fatal("expected a stored blocked name to block going public")
	}
	if _, err := h.HandleRPC("room.set_public", setPublicNamed("r1", true, "Rock"), "u"); err != nil {
		t.Fatalf("renaming should unblock: %v", err)
	}
}

// Listing-time defense in depth: a blocked name that got into state anyway is
// skipped by the directory.
func TestListPublicRooms_SkipsBlockedNames(t *testing.T) {
	h := newPublicHub()
	for id, name := range map[string]string{"good": "Rock", "bad": "p0rn"} {
		h.Join("u-"+id, id)
		room, _ := h.GetOrCreateRoom(id)
		room.mu.Lock()
		room.State.Public = true
		room.State.Name = name
		room.State.Queue = append(room.State.Queue, queue.TrackRef{ID: "t", Title: "T"})
		room.mu.Unlock()
	}
	rooms := listRooms(t, h, "u-good")
	if len(rooms) != 1 || rooms[0].RoomID != "good" {
		t.Fatalf("expected only the clean room listed, got %+v", rooms)
	}
}
