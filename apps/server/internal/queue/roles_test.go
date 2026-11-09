package queue

import "testing"

func TestSetAdmin_Add(t *testing.T) {
	rs := &RoomState{}
	changed, full := rs.SetAdmin("u1", true)
	if !changed {
		t.Error("expected changed=true on add")
	}
	if full {
		t.Error("expected full=false on first add")
	}
	if len(rs.Admins) != 1 || rs.Admins[0] != "u1" {
		t.Errorf("expected admins=[u1], got %v", rs.Admins)
	}
}

func TestSetAdmin_ReAdd(t *testing.T) {
	rs := &RoomState{Admins: []string{"u1"}}
	changed, full := rs.SetAdmin("u1", true)
	if changed {
		t.Error("expected changed=false on re-add")
	}
	if full {
		t.Error("expected full=false on re-add")
	}
}

func TestSetAdmin_Remove(t *testing.T) {
	rs := &RoomState{Admins: []string{"u1"}}
	changed, full := rs.SetAdmin("u1", false)
	if !changed {
		t.Error("expected changed=true on remove")
	}
	if full {
		t.Error("expected full=false on remove")
	}
	if rs.Admins != nil {
		t.Errorf("expected admins=nil when list empties, got %v", rs.Admins)
	}
}

func TestSetAdmin_RemoveFromMany(t *testing.T) {
	rs := &RoomState{Admins: []string{"u1", "u2", "u3"}}
	changed, _ := rs.SetAdmin("u2", false)
	if !changed {
		t.Error("expected changed=true")
	}
	if len(rs.Admins) != 2 {
		t.Errorf("expected 2 admins remaining, got %v", rs.Admins)
	}
	for _, a := range rs.Admins {
		if a == "u2" {
			t.Error("u2 still in admins after removal")
		}
	}
}

func TestSetAdmin_RemoveAbsent(t *testing.T) {
	rs := &RoomState{Admins: []string{"u1"}}
	changed, full := rs.SetAdmin("u2", false)
	if changed {
		t.Error("expected changed=false removing absent user")
	}
	if full {
		t.Error("expected full=false removing absent user")
	}
}

func TestSetAdmin_MaxAdminsFull(t *testing.T) {
	admins := make([]string, MaxAdmins)
	for i := range admins {
		admins[i] = "u" + string(rune('a'+i))
	}
	rs := &RoomState{Admins: admins}
	changed, full := rs.SetAdmin("new", true)
	if changed {
		t.Error("expected changed=false when full")
	}
	if !full {
		t.Error("expected full=true when at MaxAdmins")
	}
	if len(rs.Admins) != MaxAdmins {
		t.Errorf("expected admins count unchanged at %d, got %d", MaxAdmins, len(rs.Admins))
	}
}

func TestCanControl_EmptyUserID(t *testing.T) {
	rs := &RoomState{HostUserID: "host", OwnerUserID: "owner"}
	if rs.CanControl("") {
		t.Error("expected CanControl=false for empty userID")
	}
}

func TestCanControl_Host(t *testing.T) {
	rs := &RoomState{HostUserID: "host"}
	if !rs.CanControl("host") {
		t.Error("expected CanControl=true for host")
	}
}

func TestCanControl_Owner(t *testing.T) {
	rs := &RoomState{OwnerUserID: "owner"}
	if !rs.CanControl("owner") {
		t.Error("expected CanControl=true for owner")
	}
}

func TestCanControl_Admin(t *testing.T) {
	rs := &RoomState{Admins: []string{"admin1"}}
	if !rs.CanControl("admin1") {
		t.Error("expected CanControl=true for admin")
	}
}

func TestCanControl_NotInRoom(t *testing.T) {
	rs := &RoomState{HostUserID: "host", OwnerUserID: "owner"}
	if rs.CanControl("stranger") {
		t.Error("expected CanControl=false for unrelated user")
	}
}

func TestIsHostOrOwner_EmptyUserID(t *testing.T) {
	rs := &RoomState{HostUserID: "host", OwnerUserID: "owner"}
	if rs.IsHostOrOwner("") {
		t.Error("expected IsHostOrOwner=false for empty userID")
	}
}

func TestIsHostOrOwner_Host(t *testing.T) {
	rs := &RoomState{HostUserID: "host"}
	if !rs.IsHostOrOwner("host") {
		t.Error("expected IsHostOrOwner=true for host")
	}
}

func TestIsHostOrOwner_Owner(t *testing.T) {
	rs := &RoomState{OwnerUserID: "owner"}
	if !rs.IsHostOrOwner("owner") {
		t.Error("expected IsHostOrOwner=true for owner")
	}
}

func TestIsHostOrOwner_Admin(t *testing.T) {
	rs := &RoomState{Admins: []string{"admin1"}}
	if rs.IsHostOrOwner("admin1") {
		t.Error("expected IsHostOrOwner=false for admin (not host/owner)")
	}
}

func TestTrack_Hit(t *testing.T) {
	rs := &RoomState{
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
	}
	got := rs.Track("t2")
	if got == nil {
		t.Fatal("expected non-nil for existing track")
	}
	if got.ID != "t2" {
		t.Errorf("expected track ID t2, got %s", got.ID)
	}
}

func TestTrack_Miss(t *testing.T) {
	rs := &RoomState{
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
	}
	if rs.Track("nonexistent") != nil {
		t.Error("expected nil for missing track ID")
	}
}
