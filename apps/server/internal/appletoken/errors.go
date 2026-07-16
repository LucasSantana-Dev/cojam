package appletoken

import "errors"

// ErrNotConfigured is returned when Apple credentials are not configured
var ErrNotConfigured = errors.New("apple credentials not configured")
