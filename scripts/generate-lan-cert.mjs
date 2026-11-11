import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, X509Certificate } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const certDir = join(root, "certs");
mkdirSync(certDir, { recursive: true, mode: 0o700 });

const lanIp = process.env.LOCAL_LAN_IP || execFileSync("ipconfig", ["getifaddr", "en0"], { encoding: "utf8" }).trim();
if (!lanIp) throw new Error("Set LOCAL_LAN_IP to this Mac's Wi-Fi address and retry.");

execFileSync("mkcert", [
  "-cert-file", join(certDir, "lan.pem"),
  "-key-file", join(certDir, "lan-key.pem"),
  lanIp, "localhost", "127.0.0.1", "::1",
], { stdio: "inherit" });

const caDir = execFileSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).trim();
const caPem = readFileSync(join(caDir, "rootCA.pem"));
const ca = new X509Certificate(caPem);
const caDer = ca.raw;
const caBase64 = caDer.toString("base64");
const certUuid = randomUUID().toUpperCase();
const profileUuid = randomUUID().toUpperCase();
const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadContent</key><array><dict>
    <key>PayloadCertificateFileName</key><string>Roadie-Radio-Local-CA.cer</string>
    <key>PayloadContent</key><data>${caBase64}</data>
    <key>PayloadDescription</key><string>Local HTTPS certificate authority for the Roadie Radio development server.</string>
    <key>PayloadDisplayName</key><string>Roadie Radio Local CA</string>
    <key>PayloadIdentifier</key><string>dev.roadieradio.local-ca</string>
    <key>PayloadType</key><string>com.apple.security.root</string>
    <key>PayloadUUID</key><string>${certUuid}</string>
    <key>PayloadVersion</key><integer>1</integer>
  </dict></array>
  <key>PayloadDisplayName</key><string>Roadie Radio Local HTTPS</string>
  <key>PayloadIdentifier</key><string>dev.roadieradio.local-https</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${profileUuid}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;

writeFileSync(join(certDir, "roadie-radio-ca.mobileconfig"), profile, { mode: 0o644 });
writeFileSync(join(certDir, "roadie-radio-ca.cer"), caDer, { mode: 0o644 });
writeFileSync(join(certDir, "roadie-radio-ca.pem"), caPem, { mode: 0o644 });
console.log(`LAN HTTPS certificate ready for ${lanIp}.`);
console.log("CA profiles are in certs/roadie-radio-ca.mobileconfig and certs/roadie-radio-ca.cer.");
console.log("The CA private key stays in mkcert's local CA directory; never share it.");
