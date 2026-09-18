// Ledgerbook local server (Go, standard library only).
// Serves index.html and owns the data file. Storage resolves as:
//   ledger  : $LEDGER_PATH  -> config.json ledgerPath  -> ./ledger.json (if present) -> iCloud Drive
//   snapshot: $SNAPSHOT_DIR -> config.json snapshotDir -> <ledger dir>/snapshots
// A snapshot is written on every save (deduped; newest snapKeep retained).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
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
const appVersion = "v46" // bump together with index.html's VERSION; the app warns if they differ (restart needed)
const snapKeep = 300

// etagOf is an optimistic-concurrency token derived from the file's bytes: it changes on every
// save, so a PUT with a stale If-Match is refused (409) and a stale in-memory copy can never
// clobber a fresher file on disk.
func etagOf(b []byte) string { s := sha256.Sum256(b); return `"` + hex.EncodeToString(s[:])[:16] + `"` }

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
	iCloudDir  = filepath.Join(home(), "Library", "Mobile Documents", "com~apple~CloudDocs", "PersonalWealthTracker")
	homeDir    = filepath.Join(home(), "PersonalWealthTracker")
)

type config struct {
	LedgerPath  string `json:"ledgerPath,omitempty"`
	SnapshotDir string `json:"snapshotDir,omitempty"`
}

var cfg config
var ledger string
var snapDir string

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
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configFile, b, 0o644)
}
func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func resolveLedger(c config) string {
	if v := os.Getenv("LEDGER_PATH"); v != "" {
		return v
	}
	if c.LedgerPath != "" {
		return c.LedgerPath
	}
	if wd, err := os.Getwd(); err == nil && exists(filepath.Join(wd, "ledger.json")) {
		return filepath.Join(wd, "ledger.json")
	}
	return filepath.Join(iCloudDir, "ledger.json")
}
func resolveSnapDir(c config, led string) string {
	if v := os.Getenv("SNAPSHOT_DIR"); v != "" {
		return v
	}
	if c.SnapshotDir != "" {
		return c.SnapshotDir
	}
	return filepath.Join(filepath.Dir(led), "snapshots")
}

func stamp() string { return time.Now().Format("20060102-150405") }

func snapList() []string {
	entries, err := os.ReadDir(snapDir)
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

func writeSnapshot(body []byte) {
	if err := os.MkdirAll(snapDir, 0o755); err != nil {
		return
	}
	before := snapList()
	if len(before) > 0 {
		if last, err := os.ReadFile(filepath.Join(snapDir, before[len(before)-1])); err == nil && string(last) == string(body) {
			return // dedupe
		}
	}
	_ = os.WriteFile(filepath.Join(snapDir, project+"_"+stamp()+".json"), body, 0o644)
	after := snapList()
	for i := 0; i < len(after)-snapKeep; i++ {
		_ = os.Remove(filepath.Join(snapDir, after[i]))
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	cfg = loadConfig()
	ledger = resolveLedger(cfg)
	snapDir = resolveSnapDir(cfg, ledger)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8123"
	}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		if git("rev-parse", "--is-inside-work-tree") != "true" {
			writeJSON(w, 200, map[string]any{"appVersion": appVersion, "isRepo": false})
			return
		}
		writeJSON(w, 200, map[string]any{"appVersion": appVersion, "isRepo": true, "commit": git("rev-parse", "--short", "HEAD"),
			"tag": git("describe", "--tags", "--exact-match", "HEAD"), "dirty": git("status", "--porcelain") != ""})
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

	mux.HandleFunc("/api/location", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wd, _ := os.Getwd()
			writeJSON(w, 200, map[string]any{"ledgerPath": ledger, "snapshotDir": snapDir, "ledgerExists": exists(ledger),
				"defaults": map[string]string{"icloud": filepath.Join(iCloudDir, "ledger.json"), "home": filepath.Join(homeDir, "ledger.json"), "cwd": filepath.Join(wd, "ledger.json")}})
		case http.MethodPut:
			var o config
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &o)
			if o.LedgerPath != "" {
				if !strings.HasPrefix(o.LedgerPath, "/") {
					writeJSON(w, 400, map[string]string{"error": "ledgerPath must be an absolute path"})
					return
				}
				ledger = o.LedgerPath
				if o.SnapshotDir == "" && os.Getenv("SNAPSHOT_DIR") == "" && cfg.SnapshotDir == "" {
					snapDir = filepath.Join(filepath.Dir(ledger), "snapshots")
				}
			}
			if o.SnapshotDir != "" {
				if !strings.HasPrefix(o.SnapshotDir, "/") {
					writeJSON(w, 400, map[string]string{"error": "snapshotDir must be an absolute path"})
					return
				}
				snapDir = o.SnapshotDir
			}
			cfg.LedgerPath, cfg.SnapshotDir = ledger, snapDir
			if err := saveConfig(cfg); err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			_ = os.MkdirAll(filepath.Dir(ledger), 0o755)
			writeJSON(w, 200, map[string]any{"ledgerPath": ledger, "snapshotDir": snapDir, "ledgerExists": exists(ledger)})
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
		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(ledger)
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
				cur, e := os.ReadFile(ledger)
				if e != nil {
					cur = []byte("null")
				}
				if ifMatch != etagOf(cur) {
					w.Header().Set("ETag", etagOf(cur))
					writeJSON(w, 409, map[string]string{"error": "conflict", "message": "The ledger on disk is newer than the version you edited."})
					return
				}
			}
			if err := os.MkdirAll(filepath.Dir(ledger), 0o755); err != nil {
				http.Error(w, "mkdir error", 500)
				return
			}
			if err := os.WriteFile(ledger, body, 0o644); err != nil {
				http.Error(w, "write error", 500)
				return
			}
			writeSnapshot(body)
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
	os.Stdout.WriteString("Ledgerbook → http://" + addr + "\n  ledger:    " + ledger + "\n  snapshots: " + snapDir + "\n")
	http.ListenAndServe(addr, mux)
}
