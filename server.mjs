import { createServer } from "node:http";
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const dataDir = join(root, "data");
const storePath = join(dataDir, "rooms.json");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const livekitApiUrl = process.env.LIVEKIT_API_URL || "http://127.0.0.1:7880";
const livekitApiKey = process.env.LIVEKIT_API_KEY || "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "secret";
const appSessionSecret = process.env.APP_SESSION_SECRET || "roadie-radio-local-session-secret-change-before-deploy";
const port = Number(process.env.API_PORT || 3000);
const production = process.env.NODE_ENV === "production";
if (production) {
  const requiredSettings = ["LIVEKIT_URL", "LIVEKIT_API_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "APP_SESSION_SECRET"];
  const missingSettings = requiredSettings.filter((name) => !process.env[name]);
  if (missingSettings.length) throw new Error(`Missing production settings: ${missingSettings.join(", ")}`);
  if (livekitApiKey === "devkey" || livekitApiSecret === "secret") {
    throw new Error("Production cannot use LiveKit development credentials.");
  }
  if (appSessionSecret === "roadie-radio-local-session-secret-change-before-deploy" || appSessionSecret.length < 48) {
    throw new Error("APP_SESSION_SECRET must be a unique value of at least 48 characters in production.");
  }
  if (!process.env.LIVEKIT_URL.startsWith("wss://")) {
    throw new Error("LIVEKIT_URL must use wss:// in production.");
  }
}
const roomCapacity = 32;
const talkLeaseMs = 5000;
const alertRetentionMs = 60 * 1000;
const roomAlertTypes = {
  fuel: "Need fuel",
  stop: "Pull over",
  hazard: "Hazard ahead",
  hungry: "I'm hungry",
};
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const roomService = new RoomServiceClient(livekitApiUrl, livekitApiKey, livekitApiSecret);

function loadStore() {
  if (!existsSync(storePath)) return { rooms: {} };
  try {
    const data = JSON.parse(readFileSync(storePath, "utf8"));
    return data && typeof data.rooms === "object" ? data : { rooms: {} };
  } catch {
    throw new Error(`Room data file could not be read: ${storePath}`);
  }
}

const store = loadStore();
const liveTranscripts = new Map();
const roomLocations = new Map();
const locationRetentionMs = 90 * 1000;

function saveStore() {
  const tempPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tempPath, storePath);
}

function normalizeCode(value = "") {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

function clientLivekitUrl(req) {
  if (process.env.LIVEKIT_URL) return process.env.LIVEKIT_URL;
  let origin;
  try { origin = new URL(req.headers.origin || `http://${req.headers.host || "localhost"}`); }
  catch { origin = new URL("http://localhost"); }
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${origin.host}`;
}

function displayCode(code) {
  return code;
}

function newCode() {
  let code;
  do {
    code = randomInt(100_000_000).toString().padStart(8, "0");
  } while (store.rooms[code]);
  return code;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12_000) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Send valid JSON."), { status: 400 }); }
}

function makeSessionToken({ code, identity, name }) {
  const encoded = Buffer.from(JSON.stringify({ code, identity, name, exp: Date.now() + sessionTtlMs })).toString("base64url");
  const signature = createHmac("sha256", appSessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSessionToken(req, code) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) throw Object.assign(new Error("Room session expired. Rejoin with the room code."), { status: 401 });
  const [encoded, signature] = bearer.split(".");
  if (!encoded || !signature) throw Object.assign(new Error("Invalid room session."), { status: 401 });
  const expected = createHmac("sha256", appSessionSecret).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw Object.assign(new Error("Invalid room session."), { status: 401 });
  }
  let session;
  try { session = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid room session."), { status: 401 }); }
  if (session.code !== code || session.exp < Date.now()) {
    throw Object.assign(new Error("Room session expired. Rejoin with the room code."), { status: 401 });
  }
  return session;
}

function requireRoom(code) {
  const room = store.rooms[code];
  if (!room || room.ended) throw Object.assign(new Error("That room is no longer available."), { status: 404 });
  return room;
}

async function mintJoinInfo(room, name, req) {
  const identity = randomUUID();
  await ensureLiveKitRoom(room.code);
  const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity, name, ttl: "24h" });
  token.addGrant({ roomJoin: true, room: `roadie-${room.code}`, canPublish: false, canSubscribe: true, canPublishData: false });
  return {
    room: { code: room.code, displayCode: displayCode(room.code), name: room.name, createdAt: room.createdAt },
    livekit: { url: clientLivekitUrl(req), token: await token.toJwt(), identity },
    sessionToken: makeSessionToken({ code: room.code, identity, name }),
  };
}

async function ensureLiveKitRoom(code) {
  const name = `roadie-${code}`;
  const existing = await roomService.listRooms([name]);
  if (existing.some((room) => room.name === name)) return;
  try {
    await roomService.createRoom({ name, maxParticipants: roomCapacity, emptyTimeout: 300 });
  } catch (error) {
    // Two friends can join the same new room at once; the first create wins.
    const afterRace = await roomService.listRooms([name]).catch(() => []);
    if (!afterRace.some((room) => room.name === name)) throw error;
  }
}

async function setCanPublish(code, identity, canPublish) {
  await roomService.updateParticipant(`roadie-${code}`, identity, undefined, {
    canPublish,
    canSubscribe: true,
    canPublishData: false,
  });
}

async function expireTalkLock(room) {
  if (!room.talker || room.talker.expiresAt > Date.now()) return;
  const identity = room.talker.identity;
  room.talker = null;
  liveTranscripts.delete(room.code);
  saveStore();
  try { await setCanPublish(room.code, identity, false); } catch { /* participant may have disconnected */ }
}

function getTalkState(room) {
  if (room.talker && room.talker.expiresAt <= Date.now()) {
    const staleIdentity = room.talker.identity;
    room.talker = null;
    liveTranscripts.delete(room.code);
    saveStore();
    void setCanPublish(room.code, staleIdentity, false).catch(() => {});
  }
  return room.talker ? { identity: room.talker.identity, name: room.talker.name, expiresAt: room.talker.expiresAt } : null;
}

function getRoomAlerts(room) {
  const previous = Array.isArray(room.alerts) ? room.alerts : [];
  const cutoff = Date.now() - alertRetentionMs;
  room.alerts = previous.filter((alert) => Date.parse(alert.createdAt) >= cutoff);
  if (room.alerts.length !== previous.length) saveStore();
  return room.alerts;
}

function getRoomLocations(room) {
  const locations = roomLocations.get(room.code);
  if (!locations) return [];
  const cutoff = Date.now() - locationRetentionMs;
  for (const [identity, point] of locations) {
    if (point.updatedAt < cutoff) locations.delete(identity);
  }
  if (!locations.size) {
    roomLocations.delete(room.code);
    return [];
  }
  return [...locations.values()].map((point) => ({
    ...point,
    updatedAt: new Date(point.updatedAt).toISOString(),
  }));
}

const locationCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - locationRetentionMs;
  for (const [code, locations] of roomLocations) {
    for (const [identity, point] of locations) {
      if (point.updatedAt < cutoff) locations.delete(identity);
    }
    if (!locations.size) roomLocations.delete(code);
  }
}, 30 * 1000);
locationCleanupTimer.unref?.();

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, service: "roadie-radio", livekitUrl: clientLivekitUrl(req) });
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 24);
    const roomName = String(body.roomName || "").trim().slice(0, 40) || `${name}'s room`;
    if (!name) throw Object.assign(new Error("Enter your name first."), { status: 400 });
    const code = newCode();
    const room = { code, name: roomName, createdAt: new Date().toISOString(), ended: false, talker: null, alerts: [] };
    store.rooms[code] = room;
    saveStore();
    try { return send(res, 201, await mintJoinInfo(room, name, req)); }
    catch (error) { room.ended = true; saveStore(); throw error; }
  }

  const roomRoute = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|state|talk|transcript|alerts|location)(?:\/([^/]+))?)?$/);
  if (!roomRoute) return send(res, 404, { error: "Not found." });
  const code = normalizeCode(decodeURIComponent(roomRoute[1]));
  const action = roomRoute[2] || "";
  const alertId = roomRoute[3] || "";
  const room = store.rooms[code];

  if (req.method === "POST" && action === "join") {
    const existingRoom = requireRoom(code);
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 24);
    if (!name) throw Object.assign(new Error("Enter your name first."), { status: 400 });
    try { return send(res, 200, await mintJoinInfo(existingRoom, name, req)); }
    catch (error) { throw error; }
  }

  if (req.method === "GET" && action === "state") {
    if (!room) return send(res, 200, { ended: true });
    readSessionToken(req, code);
    await expireTalkLock(room);
    const talker = getTalkState(room);
    const transcript = liveTranscripts.get(code);
    const liveTranscript = transcript && talker?.identity === transcript.identity && Date.now() - transcript.updatedAt < 4000
      ? transcript
      : null;
    if (!liveTranscript && transcript) liveTranscripts.delete(code);
    return send(res, 200, { ended: room.ended, talker, liveTranscript, alerts: getRoomAlerts(room), locations: getRoomLocations(room) });
  }

  if (req.method === "POST" && action === "location") {
    const session = readSessionToken(req, code);
    const activeRoom = requireRoom(code);
    const body = await readBody(req);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const accuracy = Number(body.accuracy);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw Object.assign(new Error("Send a valid location."), { status: 400 });
    }
    let locations = roomLocations.get(activeRoom.code);
    if (!locations) {
      locations = new Map();
      roomLocations.set(activeRoom.code, locations);
    }
    const previous = locations.get(session.identity);
    if (previous && Date.now() - previous.updatedAt < 3000) {
      throw Object.assign(new Error("Location updates are arriving too quickly."), { status: 429 });
    }
    locations.set(session.identity, {
      identity: session.identity,
      name: session.name,
      latitude: Math.round(latitude * 100000) / 100000,
      longitude: Math.round(longitude * 100000) / 100000,
      accuracy: Number.isFinite(accuracy) ? Math.max(0, Math.min(5000, Math.round(accuracy))) : null,
      updatedAt: Date.now(),
    });
    return send(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && action === "location") {
    const session = readSessionToken(req, code);
    const locations = roomLocations.get(code);
    locations?.delete(session.identity);
    if (locations && !locations.size) roomLocations.delete(code);
    return send(res, 200, { stopped: true });
  }

  if (req.method === "POST" && action === "transcript") {
    const session = readSessionToken(req, code);
    const activeRoom = requireRoom(code);
    await expireTalkLock(activeRoom);
    if (!activeRoom.talker || activeRoom.talker.identity !== session.identity) {
      return send(res, 409, { error: "Only the current speaker can update the live transcript." });
    }
    const body = await readBody(req);
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(-220);
    if (text) liveTranscripts.set(code, { identity: session.identity, text, updatedAt: Date.now() });
    else liveTranscripts.delete(code);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "alerts") {
    const session = readSessionToken(req, code);
    const activeRoom = requireRoom(code);
    const alerts = getRoomAlerts(activeRoom);

    if (alertId) {
      const alert = alerts.find((item) => item.id === alertId);
      if (!alert) throw Object.assign(new Error("That alert has expired."), { status: 404 });
      alert.acknowledgedBy ||= [];
      if (!alert.acknowledgedBy.includes(session.identity)) alert.acknowledgedBy.push(session.identity);
      saveStore();
      return send(res, 200, { alert });
    }

    const body = await readBody(req);
    const type = String(body.type || "");
    const transcript = type === "transcript"
      ? String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 300)
      : "";
    if (type === "transcript" ? !transcript : !Object.hasOwn(roomAlertTypes, type)) {
      throw Object.assign(new Error("Choose a valid room alert."), { status: 400 });
    }
    const voice = body.voice === "male" ? "male" : "female";
    const alert = {
      id: randomUUID(),
      type,
      label: type === "transcript" ? transcript : roomAlertTypes[type],
      ...(type !== "transcript" ? { voice } : {}),
      identity: session.identity,
      name: session.name,
      createdAt: new Date().toISOString(),
      acknowledgedBy: [],
    };
    alerts.push(alert);
    saveStore();
    return send(res, 201, { alert });
  }

  if (req.method === "POST" && action === "talk") {
    const session = readSessionToken(req, code);
    const activeRoom = requireRoom(code);
    await expireTalkLock(activeRoom);
    if (activeRoom.talker && activeRoom.talker.identity !== session.identity) {
      return send(res, 409, { error: "Channel busy.", talker: getTalkState(activeRoom) });
    }
    const newlyGranted = !activeRoom.talker;
    if (newlyGranted) activeRoom.talker = { identity: session.identity, name: session.name, expiresAt: Date.now() + talkLeaseMs };
    else activeRoom.talker.expiresAt = Date.now() + talkLeaseMs;
    saveStore();
    if (newlyGranted) {
      try { await setCanPublish(code, session.identity, true); }
      catch (error) {
        if (activeRoom.talker?.identity === session.identity) activeRoom.talker = null;
        saveStore();
        throw error;
      }
    }
    return send(res, 200, { granted: true, talker: getTalkState(activeRoom) });
  }

  if (req.method === "DELETE" && action === "talk") {
    const session = readSessionToken(req, code);
    if (room?.talker?.identity === session.identity) {
      room.talker = null;
      liveTranscripts.delete(code);
      saveStore();
      try { await setCanPublish(code, session.identity, false); } catch { /* participant may have disconnected */ }
    }
    return send(res, 200, { released: true, talker: room && !room.ended ? getTalkState(room) : null });
  }

  if (req.method === "DELETE" && !action) {
    const session = readSessionToken(req, code);
    const activeRoom = requireRoom(code);
    activeRoom.ended = true;
    activeRoom.talker = null;
    liveTranscripts.delete(code);
    activeRoom.endedAt = new Date().toISOString();
    roomLocations.delete(code);
    saveStore();
    try { await roomService.deleteRoom(`roadie-${code}`); } catch { /* no LiveKit room may exist yet */ }
    return send(res, 200, { ended: true, endedBy: session.name });
  }

  return send(res, 404, { error: "Not found." });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 503;
    if (status >= 500) console.error("Roadie API error:", error.message);
    send(res, status, { error: status >= 500 ? "The room service is unavailable. Check that LiveKit is running." : error.message });
  });
});

const host = process.env.API_HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Roadie API ready at http://${host}:${port}`);
});
