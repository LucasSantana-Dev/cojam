package queue

import "testing"

func TestSetYouTubeSource(t *testing.T) {
	s := &RoomState{RoomID: "r", Queue: []TrackRef{}}
	added := s.Add(TrackRef{Title: "T", Artist: "A", AddedBy: "x"})
	v := s.Version

	if err := s.SetYouTubeSource(added.ID, SourceRef{VideoID: "vid1", Confidence: 0.7}); err != nil {
		t.Fatalf("SetYouTubeSource: %v", err)
	}
	if got := s.Queue[0].Sources.YouTube; got == nil || got.VideoID != "vid1" || got.Confidence != 0.7 {
		t.Fatalf("source not set: %+v", got)
	}
	if s.Version != v+1 {
		t.Fatalf("version = %d, want %d (must bump so clients accept the publication)", s.Version, v+1)
	}

	if err := s.SetYouTubeSource("missing", SourceRef{VideoID: "v"}); err == nil {
		t.Fatal("expected error for unknown track id")
	}
}
