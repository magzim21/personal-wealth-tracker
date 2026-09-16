package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const bookFile = "ledger.json"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/book", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			if data, err := os.ReadFile(bookFile); err == nil { w.Write(data) } else { w.Write([]byte("null")) }
		case http.MethodPut:
			body, err := io.ReadAll(r.Body)
			if err != nil { http.Error(w, "read error", 400); return }
			if err := os.WriteFile(bookFile, body, 0644); err != nil { http.Error(w, "write error", 500); return }
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", 405)
		}
	})
	mux.HandleFunc("/api/rates", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		symbol := r.URL.Query().Get("symbol")
		if key := os.Getenv("TWELVEDATA_API_KEY"); key != "" {
			resp, err := http.Get("https://api.twelvedata.com/exchange_rate?symbol=" + url.QueryEscape(symbol) + "&apikey=" + url.QueryEscape(key))
			if err != nil { http.Error(w, "upstream error", 502); return }
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			w.Write(body)
			return
		}
		cur := strings.SplitN(symbol, "/", 2)[0]
		resp, err := http.Get("https://open.er-api.com/v6/latest/USD")
		if err != nil { http.Error(w, "upstream error", 502); return }
		defer resp.Body.Close()
		var data map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&data)
		rates, _ := data["rates"].(map[string]interface{})
		if v, ok := rates[cur].(float64); ok && v != 0 {
			fmt.Fprintf(w, `{"symbol":%q,"rate":%g}`, symbol, 1.0/v)
		} else {
			w.Write([]byte(`{"rate":0}`))
		}
	})
	mux.Handle("/", http.FileServer(http.Dir(".")))
	addr := "127.0.0.1:8123"
	log.Printf("Ledgerbook at http://%s  (data file: %s)", addr, bookFile)
	log.Fatal(http.ListenAndServe(addr, mux))
}
