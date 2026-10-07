package hub

import (
	"strings"
	"unicode"
)

// Public room name filter (#259, ECA Digital). Scope: a floor, not a
// moderation system. It blocks the obvious sexual, slur and minor-sexualizing
// terms (PT-BR and EN) in the host-set label that the public directory shows to
// strangers. It cannot catch every euphemism or novel spelling; reports and the
// escalation runbook cover what it misses. The list is deliberately limited to
// terms with no common innocent reading, because a false positive only costs
// the host a rename while a false negative puts the label in front of minors.
// The word list is reviewed by the owner and the lawyer, not by the code.

// errRoomNameNotAllowed is the stable message the web maps to PT-BR copy
// (apps/web/app/room/components/PublicRoomToggle.tsx). Keep both in sync.
const errRoomNameNotAllowed = "room name not allowed"

// blockedWords match a whole token of the normalized name.
var blockedWords = map[string]bool{
	// sexual
	"sexo": true, "sex": true, "porn": true, "porno": true, "xxx": true,
	"nude": true, "nudes": true, "hentai": true, "onlyfans": true,
	"puta": true, "putaria": true, "punheta": true, "siririca": true,
	"buceta": true, "bucetinha": true, "xoxota": true, "xereca": true,
	"piroca": true, "caralho": true, "tesao": true, "gozada": true,
	"blowjob": true, "handjob": true, "cumshot": true, "orgia": true,
	"orgy": true, "bdsm": true, "pussy": true, "dick": true, "cock": true,
	"boobs": true, "tits": true, "anal": true,
	// slurs
	"nigger": true, "nigga": true, "faggot": true, "fag": true, "tranny": true,
	"retard": true, "chink": true, "spic": true, "kike": true, "viado": true,
	"sapatao": true, "crioulo": true,
	// minor-sexualizing, rape, abuse
	"pedo": true, "pedofilo": true, "pedofilia": true, "pedophile": true,
	"loli": true, "lolicon": true, "shota": true, "shotacon": true,
	"estupro": true, "estuprador": true, "rape": true, "rapist": true,
	"incesto": true, "incest": true, "zoofilia": true, "bestiality": true,
}

// blockedFragments match anywhere in the squashed name (spaces and punctuation
// removed), which defeats "p o r n" and "po.rn". Only long, unambiguous stems
// belong here: short ones would flag innocent words (Scunthorpe problem).
var blockedFragments = []string{
	"pedofil", "pedophil", "paedophil", "pornograf", "estupr", "nigger",
	"faggot", "buceta", "xoxota", "punheta", "lolicon", "shotacon",
	"childporn", "kidporn", "criancanua", "menornua", "meninanua",
	"novinhanua", "sexoanal", "sexooral",
}

var accentFold = map[rune]rune{
	'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
	'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
	'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
	'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
	'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
	'ç': 'c', 'ñ': 'n', 'ý': 'y',
}

var leetFold = map[rune]rune{
	'0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
	'@': 'a', '$': 's', '!': 'i', '+': 't', '€': 'e', '|': 'i',
}

// foldFullwidth maps fullwidth ASCII (U+FF01..U+FF5E) to its ASCII form.
func foldFullwidth(r rune) rune {
	if r >= 0xFF01 && r <= 0xFF5E {
		return r - 0xFEE0
	}
	return r
}

// normalizeNameForFilter returns the lowercased, accent-folded, leetspeak
// normalized form of s, keeping word separators as single spaces. oneAs is
// what the digit 1 reads as: "i" (p1ca) or "l".
func normalizeNameForFilter(s string, oneAs rune) string {
	var b strings.Builder
	lastSpace := true
	for _, r := range strings.ToLower(strings.Map(foldFullwidth, s)) {
		if f, ok := accentFold[r]; ok {
			r = f
		}
		if r == '1' {
			r = oneAs
		} else if f, ok := leetFold[r]; ok {
			r = f
		}
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastSpace = false
		case unicode.Is(unicode.Mn, r), r == '​', r == '‌', r == '‍', r == '­':
			// combining marks and zero-width characters are invisible padding
		default:
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}

// collapseRepeats folds runs of the same letter ("puuuta" -> "puta").
func collapseRepeats(s string) string {
	var b strings.Builder
	var prev rune
	for _, r := range s {
		if r == prev && r != ' ' {
			continue
		}
		b.WriteRune(r)
		prev = r
	}
	return b.String()
}

// joinSingles merges runs of single-character tokens ("p u t a" -> "puta").
func joinSingles(tokens []string) []string {
	var out []string
	var run strings.Builder
	flush := func() {
		if run.Len() > 0 {
			out = append(out, run.String())
			run.Reset()
		}
	}
	for _, t := range tokens {
		if len([]rune(t)) == 1 {
			run.WriteString(t)
			continue
		}
		flush()
		out = append(out, t)
	}
	flush()
	return out
}

// roomNameBlocked reports whether a public room label matches the blocklist.
func roomNameBlocked(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	for _, one := range []rune{'i', 'l'} {
		norm := normalizeNameForFilter(name, one)
		for _, view := range []string{norm, collapseRepeats(norm)} {
			for _, t := range joinSingles(strings.Fields(view)) {
				if blockedWords[t] {
					return true
				}
			}
			squashed := strings.ReplaceAll(view, " ", "")
			for _, f := range blockedFragments {
				if strings.Contains(squashed, f) {
					return true
				}
			}
		}
	}
	return false
}
