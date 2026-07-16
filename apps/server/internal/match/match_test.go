package match

import (
	"strings"
	"testing"
)

func TestCalculateConfidence(t *testing.T) {
	tests := []struct {
		name      string
		query     string
		title     string
		expected  float64
		tolerance float64
	}{
		{
			name:      "perfect match",
			query:     "hello world",
			title:     "hello world song",
			expected:  1.0,
			tolerance: 0.01,
		},
		{
			name:      "partial match",
			query:     "hello world test",
			title:     "hello song",
			expected:  0.33,
			tolerance: 0.02,
		},
		{
			name:      "no match",
			query:     "hello world",
			title:     "goodbye stranger",
			expected:  0.0,
			tolerance: 0.01,
		},
		{
			name:      "case insensitive",
			query:     "Hello World",
			title:     "hello world song",
			expected:  1.0,
			tolerance: 0.01,
		},
		{
			name:      "single token match",
			query:     "test",
			title:     "test song",
			expected:  1.0,
			tolerance: 0.01,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			queryTokens := strings.Fields(strings.ToLower(tt.query))
			titleTokens := strings.Fields(strings.ToLower(tt.title))
			result := calculateConfidence(queryTokens, titleTokens)

			if diff := result - tt.expected; diff < -tt.tolerance || diff > tt.tolerance {
				t.Errorf("expected %.2f, got %.2f (diff: %.4f)", tt.expected, result, diff)
			}
		})
	}
}
