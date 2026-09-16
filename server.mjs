import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
const FILE = "ledger.json";
createServer(async (req, res) => {
  if (req.url === "/api/ping") { res.writeHead(200); return res.end("ok"); }
  if (req.url && req.url.startsWith("/api/rates")) {
    const u = new URL(req.url, "http://x");
    const symbol = u.searchParams.get("symbol") || "";
    const key = process.env.TWELVEDATA_API_KEY;
    res.setHeader("content-type", "application/json");
    try {
      if (key) {
        const up = await fetch("https://api.twelvedata.com/exchange_rate?symbol=" + encodeURIComponent(symbol) + "&apikey=" + encodeURIComponent(key));
        res.writeHead(200); return res.end(await up.text());
      }
      const cur = symbol.split("/")[0];
      const up = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await up.json();
      const v = j && j.rates && j.rates[cur];
      res.writeHead(200); return res.end(JSON.stringify({ symbol, rate: v ? 1 / v : 0 }));
    } catch { res.writeHead(502); return res.end(JSON.stringify({ rate: 0 })); }
  }
  if (req.url === "/api/book") {
    if (req.method === "GET") {
      try { const d = await readFile(FILE); res.writeHead(200, {"content-type":"application/json"}); res.end(d); }
      catch { res.writeHead(200, {"content-type":"application/json"}); res.end("null"); }
      return;
    }
    if (req.method === "PUT") { let b=""; req.on("data",c=>b+=c); req.on("end", async()=>{ await writeFile(FILE,b); res.writeHead(204); res.end(); }); return; }
  }
  const p = req.url === "/" ? "/index.html" : req.url;
  try { const d = await readFile("." + p); const ct = p.endsWith(".html") ? "text/html" : "application/octet-stream"; res.writeHead(200,{"content-type":ct}); res.end(d); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(8123, "127.0.0.1", () => console.log("Ledgerbook at http://127.0.0.1:8123"));
