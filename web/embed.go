// Package web holds the static files of the dashboard UI.
package web

import "embed"

// FS contains index.html and the assets it loads.
//
//go:embed index.html app.js style.css kybernate-mark.svg favicon.svg
var FS embed.FS
