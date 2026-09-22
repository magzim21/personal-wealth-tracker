// Ledgerbook local server (Go, standard library only).
// Serves index.html and owns the data files. Many ledgers: config.json holds a registry
// { ledgersRoot, current, ledgers:[{id,name,path,snapshotDir,color}] } and the server always
// reads/writes the CURRENT ledger. /api/ledgers lists, creates, switches, renames, recolours and
// removes them. A v1 single-ledger config (or a fresh start) is migrated into the registry WITHOUT
// moving any file. New ledgers are created under ledgersRoot (iCloud Drive when present, else
// ~/PersonalWealthTracker).
//   ledger override : $LEDGER_PATH   (applies to the current ledger)
//   snapshot override: $SNAPSHOT_DIR  (applies to the current ledger)
// A snapshot is written on every save (deduped; newest snapKeep retained).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func git(args ...string) string {
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

const project = "personal-wealth-tracker"
const snapKeep = 300
const configSchema = 2

// Single source of truth: the version lives ONLY in index.html's VERSION, read once at startup
// (frozen for this process) so the frontend can detect a stale, not-yet-restarted server.
var appVersion = readAppVersion()

// Robust stale-server detection: hash server.go at startup; if the source on disk changes afterwards,
// /api/version reports stale and the app prompts a restart (the binary must also be rebuilt).
func fileHash(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])[:16]
}

var startSelfHash = fileHash("server.go")

func readAppVersion() string {
	b, err := os.ReadFile("index.html")
	if err != nil {
		return "unknown"
	}
	if m := regexp.MustCompile(`const VERSION="(v\d+)"`).FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return "unknown"
}

// etagOf is an optimistic-concurrency token derived from the file's bytes: it changes on every
// save, so a PUT with a stale If-Match is refused (409) and a stale in-memory copy can never
// clobber a fresher file on disk.
func etagOf(b []byte) string { s := sha256.Sum256(b); return `"` + hex.EncodeToString(s[:])[:16] + `"` }

// historyLoss is the server's append-only backstop for /api/book PUT. The frontend enforces
// "never delete, only tombstone" and an append-only auditLog, but that lived only in the
// browser: a raw PUT (a hand-rolled API call, a buggy or stale client, a full overwrite) could
// silently erase transactions with no trace. This refuses a write that drops an existing
// transaction id or shrinks the auditLog, returning a human reason (or "" if the write is a
// legitimate superset). A deliberate whole-book replace (import / restore) bypasses it with
// ?replace=1, and a pre-overwrite snapshot is kept even then.
func historyLoss(prev, next []byte) string {
	type line struct {
		Transactions []struct {
			ID string `json:"id"`
		} `json:"transactions"`
		AuditLog []json.RawMessage `json:"auditLog"`
	}
	var p, n line
	if json.Unmarshal(prev, &p) != nil {
		return "" // unreadable prior file — nothing to protect
	}
	if json.Unmarshal(next, &n) != nil {
		return "" // body validity is handled by the caller
	}
	after := map[string]bool{}
	for _, t := range n.Transactions {
		if t.ID != "" {
			after[t.ID] = true
		}
	}
	var missing []string
	for _, t := range p.Transactions {
		if t.ID != "" && !after[t.ID] {
			missing = append(missing, t.ID)
		}
	}
	if len(missing) > 0 {
		eg := missing
		if len(eg) > 3 {
			eg = eg[:3]
		}
		return fmt.Sprintf("Refusing to drop %d existing transaction id(s) (e.g. %s) — history is append-only, so archive with a tombstone instead of deleting.", len(missing), strings.Join(eg, ", "))
	}
	if len(n.AuditLog) < len(p.AuditLog) {
		return fmt.Sprintf("Refusing to shrink the audit log from %d to %d entries — it is append-only.", len(p.AuditLog), len(n.AuditLog))
	}
	return ""
}

func home() string { h, _ := os.UserHomeDir(); return h }

func defaultConfigDir() string {
	if v := os.Getenv("PWT_CONFIG_DIR"); v != "" {
		return v
	}
	wd, _ := os.Getwd()
	return filepath.Join(wd, ".pwt") // project-local (git-ignored), not a hidden system folder
}

var (
	configDir  = defaultConfigDir()
	configFile = filepath.Join(configDir, "config.json")
	iCloudBase = filepath.Join(home(), "Library", "Mobile Documents", "com~apple~CloudDocs")
	iCloudDir  = filepath.Join(iCloudBase, "PersonalWealthTracker")
	homeDir    = filepath.Join(home(), "PersonalWealthTracker")
	// New ledgers land here: iCloud Drive when it exists (syncs across the user's Macs), else a plain home folder.
	defaultRoot = func() string { if exists(iCloudBase) { return iCloudDir }; return homeDir }()
	// A fixed set of distinct identity colours; each ledger gets a different one.
	palette = []string{"#2f7d5b", "#3563b8", "#b0741a", "#8a4fbe", "#b23a48", "#2a8f8f", "#6b8f2a", "#c25d8a", "#4a6fa5", "#a0562a", "#5a5f8f", "#3f8f5a"}
)

type ledgerEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	SnapshotDir string `json:"snapshotDir"`
	Color       string `json:"color"`
	LastOpened  int64  `json:"lastOpened,omitempty"`
}

type config struct {
	Schema      int           `json:"schema,omitempty"`
	LedgersRoot string        `json:"ledgersRoot,omitempty"`
	Current     string        `json:"current,omitempty"`
	Ledgers     []ledgerEntry `json:"ledgers,omitempty"`
	// legacy v1 fields, read only to migrate
	LedgerPath  string `json:"ledgerPath,omitempty"`
	SnapshotDir string `json:"snapshotDir,omitempty"`
}

var cfg config
var ledger string
var snapDir string

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func uid() string {
	const cs = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	for i := range b {
		b[i] = cs[rand.Intn(len(cs))]
	}
	return string(b)
}

func slug(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash {
			b.WriteByte('-')
			prevDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = out[:40]
	}
	if out == "" {
		out = "ledger"
	}
	return out
}

func nextColor(ledgers []ledgerEntry) string {
	used := map[string]bool{}
	for _, l := range ledgers {
		used[l.Color] = true
	}
	for _, c := range palette {
		if !used[c] {
			return c
		}
	}
	return palette[len(ledgers)%len(palette)]
}

func loadConfig() config {
	var c config
	if b, err := os.ReadFile(configFile); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}
func saveConfig(c config) error {
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	// don't persist the legacy fields back out
	c.LedgerPath, c.SnapshotDir = "", ""
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configFile, b, 0o644)
}

// migrate brings any older config shape up to the registry, without moving a single file on disk.
func migrate(c config) config {
	if len(c.Ledgers) > 0 {
		c.Schema = configSchema
		if c.LedgersRoot == "" {
			c.LedgersRoot = defaultRoot
		}
		for i := range c.Ledgers {
			if c.Ledgers[i].ID == "" {
				c.Ledgers[i].ID = uid()
			}
			if c.Ledgers[i].Color == "" {
				c.Ledgers[i].Color = palette[i%len(palette)]
			}
			if c.Ledgers[i].SnapshotDir == "" {
				c.Ledgers[i].SnapshotDir = filepath.Join(filepath.Dir(c.Ledgers[i].Path), "snapshots")
			}
		}
		if c.Current == "" {
			c.Current = c.Ledgers[0].ID
		}
		for i := range c.Ledgers { // give the current ledger a recency anchor
			if c.Ledgers[i].ID == c.Current && c.Ledgers[i].LastOpened == 0 {
				c.Ledgers[i].LastOpened = time.Now().UnixMilli()
			}
		}
		return c
	}
	oldPath := os.Getenv("LEDGER_PATH")
	if oldPath == "" {
		oldPath = c.LedgerPath
	}
	if oldPath == "" {
		if wd, err := os.Getwd(); err == nil && exists(filepath.Join(wd, "ledger.json")) {
			oldPath = filepath.Join(wd, "ledger.json")
		} else {
			oldPath = filepath.Join(defaultRoot, "ledger.json")
		}
	}
	oldSnap := os.Getenv("SNAPSHOT_DIR")
	if oldSnap == "" {
		oldSnap = c.SnapshotDir
	}
	if oldSnap == "" {
		oldSnap = filepath.Join(filepath.Dir(oldPath), "snapshots")
	}
	root := c.LedgersRoot
	if root == "" {
		root = defaultRoot
	}
	id := uid()
	return config{Schema: configSchema, LedgersRoot: root, Current: id, Ledgers: []ledgerEntry{{ID: id, Name: "My ledger", Path: oldPath, SnapshotDir: oldSnap, Color: palette[0], LastOpened: time.Now().UnixMilli()}}}
}

func curEntry() *ledgerEntry {
	for i := range cfg.Ledgers {
		if cfg.Ledgers[i].ID == cfg.Current {
			return &cfg.Ledgers[i]
		}
	}
	if len(cfg.Ledgers) > 0 {
		return &cfg.Ledgers[0]
	}
	return nil
}
func pathOf(e *ledgerEntry) string {
	if v := os.Getenv("LEDGER_PATH"); v != "" {
		return v
	}
	return e.Path
}
func snapOf(e *ledgerEntry) string {
	if v := os.Getenv("SNAPSHOT_DIR"); v != "" {
		return v
	}
	if e.SnapshotDir != "" {
		return e.SnapshotDir
	}
	return filepath.Join(filepath.Dir(pathOf(e)), "snapshots")
}
func useCurrent() {
	if e := curEntry(); e != nil {
		ledger = pathOf(e)
		snapDir = snapOf(e)
	}
}

// lastTxDate returns the latest non-deleted transaction date (YYYY-MM-DD) in a ledger file, or "".
func lastTxDate(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	var j struct {
		Transactions []struct {
			Date    string `json:"date"`
			Deleted bool   `json:"deleted"`
		} `json:"transactions"`
	}
	if json.Unmarshal(b, &j) != nil {
		return ""
	}
	mx := ""
	for _, t := range j.Transactions {
		if !t.Deleted && t.Date > mx {
			mx = t.Date
		}
	}
	return mx
}

func stamp() string { return time.Now().Format("20060102-150405") }

func snapList(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, project+"_") && strings.HasSuffix(n, ".json") {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func writeSnapshot(body []byte, snap string) {
	if err := os.MkdirAll(snap, 0o755); err != nil {
		return
	}
	before := snapList(snap)
	if len(before) > 0 {
		if last, err := os.ReadFile(filepath.Join(snap, before[len(before)-1])); err == nil && string(last) == string(body) {
			return // dedupe
		}
	}
	_ = os.WriteFile(filepath.Join(snap, project+"_"+stamp()+".json"), body, 0o644)
	after := snapList(snap)
	for i := 0; i < len(after)-snapKeep; i++ {
		_ = os.Remove(filepath.Join(snap, after[i]))
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	cfg = migrate(loadConfig())
	_ = saveConfig(cfg) // persist the migrated registry once at startup
	useCurrent()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8123"
	}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		stale := startSelfHash != "" && fileHash("server.go") != startSelfHash
		if git("rev-parse", "--is-inside-work-tree") != "true" {
			writeJSON(w, 200, map[string]any{"appVersion": appVersion, "isRepo": false, "stale": stale})
			return
		}
		writeJSON(w, 200, map[string]any{"appVersion": appVersion, "isRepo": true, "stale": stale, "commit": git("rev-parse", "--short", "HEAD"),
			"tag": git("describe", "--tags", "--exact-match", "HEAD"), "date": git("show", "-s", "--format=%cs", "HEAD"), "dirty": git("status", "--porcelain") != ""})
	})

	mux.HandleFunc("/api/pick", func(w http.ResponseWriter, r *http.Request) {
		kind := r.URL.Query().Get("kind")
		script := `POSIX path of (choose folder with prompt "Choose a folder")`
		if kind == "file" {
			script = `POSIX path of (choose file with prompt "Locate your ledger file")`
		}
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			writeJSON(w, 200, map[string]any{"cancelled": true})
			return
		}
		writeJSON(w, 200, map[string]any{"path": strings.TrimSpace(string(out))})
	})

	// ---- ledger registry: list / create / switch / rename / recolour / remove ----
	mux.HandleFunc("/api/ledgers", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			used := make([]string, 0, len(cfg.Ledgers))
			for _, l := range cfg.Ledgers {
				used = append(used, l.Color)
			}
			ordered := make([]ledgerEntry, len(cfg.Ledgers))
			copy(ordered, cfg.Ledgers)
			sort.SliceStable(ordered, func(a, b int) bool { // current on top, then most-recently-opened
				if ordered[a].ID == cfg.Current {
					return true
				}
				if ordered[b].ID == cfg.Current {
					return false
				}
				return ordered[a].LastOpened > ordered[b].LastOpened
			})
			led := make([]map[string]any, 0, len(ordered))
			for i := range ordered {
				l := &ordered[i]
				led = append(led, map[string]any{"id": l.ID, "name": l.Name, "path": l.Path, "color": l.Color, "exists": exists(pathOf(l)), "current": l.ID == cfg.Current, "lastTx": lastTxDate(pathOf(l))})
			}
			writeJSON(w, 200, map[string]any{"ledgersRoot": cfg.LedgersRoot, "current": cfg.Current, "palette": palette, "usedColors": used, "ledgers": led})
		case http.MethodPost:
			var o struct{ Name, Color, Dir string }
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &o)
			name := strings.TrimSpace(o.Name)
			if name == "" {
				name = "New ledger"
			}
			for _, l := range cfg.Ledgers { // refuse a duplicate name instead of appending a suffix
				if strings.EqualFold(strings.TrimSpace(l.Name), name) {
					writeJSON(w, 409, map[string]string{"error": "A ledger named “" + name + "” already exists. Pick a different name."})
					return
				}
			}
			color := o.Color
			if color != "" {
				for _, l := range cfg.Ledgers {
					if l.Color == color {
						writeJSON(w, 409, map[string]string{"error": "That colour is already used by another ledger."})
						return
					}
				}
			} else {
				color = nextColor(cfg.Ledgers)
			}
			root := cfg.LedgersRoot
			if o.Dir != "" && strings.HasPrefix(o.Dir, "/") { // caller may pick a target folder
				root = o.Dir
			}
			p := filepath.Join(root, slug(name)+".json") // filename = the ledger name, no silent -N suffix
			taken := exists(p)
			for _, l := range cfg.Ledgers {
				if l.Path == p {
					taken = true
				}
			}
			if taken {
				writeJSON(w, 409, map[string]string{"error": "A file already exists at " + p + ". Pick a different name or folder."})
				return
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			if !exists(p) {
				_ = os.WriteFile(p, []byte("null"), 0o644)
			}
			e := ledgerEntry{ID: uid(), Name: name, Path: p, SnapshotDir: filepath.Join(root, "snapshots", strings.TrimSuffix(filepath.Base(p), ".json")), Color: color, LastOpened: time.Now().UnixMilli()}
			cfg.Ledgers = append(cfg.Ledgers, e)
			cfg.Current = e.ID
			_ = saveConfig(cfg)
			useCurrent()
			writeJSON(w, 200, map[string]any{"ok": true, "id": e.ID, "current": cfg.Current})
		case http.MethodPut:
			var o struct {
				Op, ID, Name, Color string
				Snapshots           bool
			}
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &o)
			find := func(id string) *ledgerEntry {
				for i := range cfg.Ledgers {
					if cfg.Ledgers[i].ID == id {
						return &cfg.Ledgers[i]
					}
				}
				return nil
			}
			e := find(o.ID)
			switch o.Op {
			case "switch":
				if e == nil {
					writeJSON(w, 404, map[string]string{"error": "no such ledger"})
					return
				}
				e.LastOpened = time.Now().UnixMilli()
				cfg.Current = e.ID
				_ = saveConfig(cfg)
				useCurrent()
				writeJSON(w, 200, map[string]any{"ok": true, "current": cfg.Current})
			case "rename":
				if e == nil {
					writeJSON(w, 404, map[string]string{"error": "no such ledger"})
					return
				}
				if n := strings.TrimSpace(o.Name); n != "" {
					e.Name = n
				}
				_ = saveConfig(cfg)
				writeJSON(w, 200, map[string]any{"ok": true})
			case "color":
				if e == nil {
					writeJSON(w, 404, map[string]string{"error": "no such ledger"})
					return
				}
				for _, l := range cfg.Ledgers {
					if l.ID != e.ID && l.Color == o.Color {
						writeJSON(w, 409, map[string]string{"error": "That colour is already used by another ledger."})
						return
					}
				}
				e.Color = o.Color
				_ = saveConfig(cfg)
				writeJSON(w, 200, map[string]any{"ok": true})
			case "remove":
				if e == nil {
					writeJSON(w, 404, map[string]string{"error": "no such ledger"})
					return
				}
				removedID := e.ID
				snapToDel := ""
				if o.Snapshots && e.SnapshotDir != "" { // opt-in: delete THIS ledger's snapshots (the ledger file always stays)
					snapToDel = e.SnapshotDir
				}
				kept := make([]ledgerEntry, 0, len(cfg.Ledgers))
				for _, l := range cfg.Ledgers {
					if l.ID != removedID {
						kept = append(kept, l)
					}
				}
				cfg.Ledgers = kept
				if len(cfg.Ledgers) == 0 {
					id := uid()
					p := filepath.Join(cfg.LedgersRoot, "ledger.json")
					cfg.Ledgers = []ledgerEntry{{ID: id, Name: "My ledger", Path: p, SnapshotDir: filepath.Join(cfg.LedgersRoot, "snapshots", "ledger"), Color: palette[0]}}
					cfg.Current = id
					_ = os.MkdirAll(filepath.Dir(p), 0o755)
					if !exists(p) {
						_ = os.WriteFile(p, []byte("null"), 0o644)
					}
				} else if cfg.Current == removedID {
					cfg.Current = cfg.Ledgers[0].ID
				}
				_ = saveConfig(cfg)
				useCurrent()
				if snapToDel != "" {
					_ = os.RemoveAll(snapToDel)
				}
				writeJSON(w, 200, map[string]any{"ok": true, "current": cfg.Current})
			default:
				writeJSON(w, 400, map[string]string{"error": "unknown op"})
			}
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	mux.HandleFunc("/api/location", func(w http.ResponseWriter, r *http.Request) {
		e := curEntry()
		switch r.Method {
		case http.MethodGet:
			wd, _ := os.Getwd()
			writeJSON(w, 200, map[string]any{"ledgerPath": pathOf(e), "snapshotDir": snapOf(e), "ledgerExists": exists(pathOf(e)),
				"defaults": map[string]string{"icloud": filepath.Join(iCloudDir, "ledger.json"), "home": filepath.Join(homeDir, "ledger.json"), "cwd": filepath.Join(wd, "ledger.json")}})
		case http.MethodPut:
			var o struct{ LedgerPath, SnapshotDir string }
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &o)
			if o.LedgerPath != "" {
				if !strings.HasPrefix(o.LedgerPath, "/") {
					writeJSON(w, 400, map[string]string{"error": "ledgerPath must be an absolute path"})
					return
				}
				e.Path = o.LedgerPath
				if o.SnapshotDir == "" {
					e.SnapshotDir = filepath.Join(filepath.Dir(e.Path), "snapshots")
				}
			}
			if o.SnapshotDir != "" {
				if !strings.HasPrefix(o.SnapshotDir, "/") {
					writeJSON(w, 400, map[string]string{"error": "snapshotDir must be an absolute path"})
					return
				}
				e.SnapshotDir = o.SnapshotDir
			}
			if err := saveConfig(cfg); err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			useCurrent()
			_ = os.MkdirAll(filepath.Dir(ledger), 0o755)
			writeJSON(w, 200, map[string]any{"ledgerPath": pathOf(e), "snapshotDir": snapOf(e), "ledgerExists": exists(pathOf(e))})
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	mux.HandleFunc("/api/rates", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		symbol := r.URL.Query().Get("symbol")
		if key := os.Getenv("TWELVEDATA_API_KEY"); key != "" {
			resp, err := http.Get("https://api.twelvedata.com/exchange_rate?symbol=" + url.QueryEscape(symbol) + "&apikey=" + url.QueryEscape(key))
			if err != nil {
				http.Error(w, "upstream error", 502)
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			w.Write(body)
			return
		}
		cur := strings.SplitN(symbol, "/", 2)[0]
		resp, err := http.Get("https://open.er-api.com/v6/latest/USD")
		if err != nil {
			http.Error(w, "upstream error", 502)
			return
		}
		defer resp.Body.Close()
		var data map[string]any
		json.NewDecoder(resp.Body).Decode(&data)
		rates, _ := data["rates"].(map[string]any)
		if v, ok := rates[cur].(float64); ok && v != 0 {
			writeJSON(w, 200, map[string]any{"symbol": symbol, "rate": 1.0 / v})
		} else {
			w.Write([]byte(`{"rate":0}`))
		}
	})

	mux.HandleFunc("/api/book", func(w http.ResponseWriter, r *http.Request) {
		// Pin to an explicit ledger id when supplied, so a client editing ledger X always hits X's
		// file regardless of the server's "current" (unknown id → 409). No id → the current ledger.
		file, snap := ledger, snapDir
		if lid := r.URL.Query().Get("ledger"); lid != "" {
			var found *ledgerEntry
			for i := range cfg.Ledgers {
				if cfg.Ledgers[i].ID == lid {
					found = &cfg.Ledgers[i]
				}
			}
			if found == nil {
				writeJSON(w, 409, map[string]string{"error": "wrong-ledger", "message": "That ledger is no longer in the registry — reload."})
				return
			}
			file, snap = pathOf(found), snapOf(found)
		}
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(file)
			if err != nil {
				data = []byte("null")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", etagOf(data))
			w.Write(data)
		case http.MethodPut:
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "read error", 400)
				return
			}
			// Optimistic concurrency: if the client sent the revision it edited (If-Match), the
			// file on disk must still be at that revision, else refuse (409) and leave it untouched.
			if ifMatch := r.Header.Get("If-Match"); ifMatch != "" {
				cur, e := os.ReadFile(file)
				if e != nil {
					cur = []byte("null")
				}
				if ifMatch != etagOf(cur) {
					w.Header().Set("ETag", etagOf(cur))
					writeJSON(w, 409, map[string]string{"error": "conflict", "message": "The ledger on disk is newer than the version you edited."})
					return
				}
			}
			replace := r.URL.Query().Get("replace") == "1"
			prevBytes, prevErr := os.ReadFile(file)
			if !replace && prevErr == nil {
				if !json.Valid(body) {
					writeJSON(w, 400, map[string]string{"error": "bad-json", "message": "Request body is not valid JSON."})
					return
				}
				if drop := historyLoss(prevBytes, body); drop != "" {
					w.Header().Set("ETag", etagOf(prevBytes))
					writeJSON(w, 409, map[string]string{"error": "history-loss", "message": drop + " Pass ?replace=1 only when you mean to replace the whole book (import / restore)."})
					return
				}
			}
			// Snapshot the version being overwritten before touching the file, so even a
			// ?replace=1 whole-book replace leaves the pre-replace book recoverable.
			if replace && prevErr == nil {
				writeSnapshot(prevBytes, snap)
			}
			if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
				http.Error(w, "mkdir error", 500)
				return
			}
			if err := os.WriteFile(file, body, 0o644); err != nil {
				http.Error(w, "write error", 500)
				return
			}
			writeSnapshot(body, snap)
			w.Header().Set("ETag", etagOf(body))
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", 405)
		}
	})

	fs := http.FileServer(http.Dir("."))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fs.ServeHTTP(w, r)
	})

	addr := "127.0.0.1:" + port
	name := ""
	if e := curEntry(); e != nil {
		name = e.Name
	}
	os.Stdout.WriteString("Ledgerbook → http://" + addr + "\n  ledger:    " + name + " — " + ledger + "\n  snapshots: " + snapDir + "\n")
	http.ListenAndServe(addr, mux)
}
