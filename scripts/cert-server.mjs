import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const certDir = join(root, "certs");
const files = {
  "/roadie-radio-ca.mobileconfig": {
    path: join(certDir, "roadie-radio-ca.mobileconfig"),
    type: "application/x-apple-aspen-config",
    name: "roadie-radio-ca.mobileconfig",
  },
  "/roadie-radio-ca.cer": {
    path: join(certDir, "roadie-radio-ca.cer"),
    type: "application/pkix-cert",
    name: "roadie-radio-ca.cer",
  },
};

createServer((req, res) => {
  const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  if (pathname === "/" || pathname === "/index.html") {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const host = String(req.headers.host || "localhost").replace(/:\d+$/, "");
    const requestedRoom = String(requestUrl.searchParams.get("room") || "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
    const roomQuery = requestedRoom ? `?room=${encodeURIComponent(requestedRoom)}` : "";
    const secureLink = `https://${host}:4175/${roomQuery}`;
    const page = `<!doctype html><meta name="viewport" content="width=device-width"><title>Roadie Radio HTTPS setup</title><style>body{font:16px system-ui;max-width:38rem;margin:3rem auto;padding:0 1.2rem;color:#202821}a{display:block;padding:1rem;margin:1rem 0;border-radius:12px;background:#edf4ee;color:#315f49;text-decoration:none;font-weight:650}small{color:#667269;line-height:1.5}</style><h1>Enable secure microphone access</h1><p>Install the local certificate on this device, then open the secure app.</p><a href="/roadie-radio-ca.mobileconfig">Install certificate profile (iPhone/iPad)</a><a href="/roadie-radio-ca.cer">Download CA certificate (Android)</a><a href="${secureLink}">Open Roadie Radio securely</a><p><small>On iPhone/iPad, after installing the profile, enable full trust for Roadie Radio Local CA in Settings &gt; General &gt; About &gt; Certificate Trust Settings. On Android, install the CA certificate from Security &gt; Encryption &amp; credentials.</small></p><small>This adds trust for certificates issued by this Mac's local development CA. Remove the profile/certificate from device settings when you no longer need LAN development.</small>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(page);
  }
  const file = files[pathname];
  if (!file) {
    res.writeHead(404);
    return res.end("Not found");
  }
  if (!existsSync(file.path)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Run npm run setup:lan-cert first.");
  }
  res.writeHead(200, {
    "content-type": file.type,
    "content-disposition": `attachment; filename="${file.name}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(readFileSync(file.path));
}).listen(4174, "0.0.0.0", () => {
  console.log("Local certificate download page at http://0.0.0.0:4174");
});
