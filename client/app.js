const $ = (selector) => document.querySelector(selector);
// Set to false to turn off optional browser-based PTT transcription.
const VOICE_TO_TEXT_ENABLED = true;
const welcomeView = $("#welcomeView");
const roomView = $("#roomView");
const displayNameInput = $("#displayNameInput");
const roomCodeInput = $("#roomCodeInput");
const welcomeError = $("#welcomeError");
const pttButton = $("#pttButton");
const transmitCaption = $("#transmitCaption");
const liveTranscript = $("#liveTranscript");
const pttHint = $("#pttHint");
const liveMessage = $("#liveMessage");
const inviteModal = $("#inviteModal");
const endRoomModal = $("#endRoomModal");
const toast = $("#toast");
const alertVoiceButtons = [...document.querySelectorAll("[data-alert-voice]")];
const themePicker = $("#themePicker");
const themeToggle = $("#themeToggle");
const themeMenu = $("#themeMenu");
const roomThemes = ["roadie", "midnight", "sunset", "highway", "gray", "black", "purple", "teal", "maroon", "cherry"];
const themeChromeColors = {
  roadie: "#f2f5ef",
  midnight: "#101b2d",
  sunset: "#fbf1e7",
  highway: "#17191c",
  gray: "#e9ecef",
  black: "#090a0c",
  purple: "#f4f0ff",
  teal: "#e9fbf8",
  maroon: "#2a0713",
  cherry: "#fff0f4",
};

let currentRoom = null;
let liveRoom = null;
let livekitSdk = null;
let localMic = null;
let sessionToken = null;
let transmitHeld = false;
let transmitGranted = false;
let transmitAttempt = 0;
let transmitHeartbeat = null;
let statePoll = null;
let stateRequestInFlight = false;
let stateFailureCount = 0;
let roomStateHealthy = false;
let reconnectLoopPromise = null;
let reconnectWake = null;
let suppressReconnect = false;
let toastTimer = null;
let floorState = null;
let speakerOn = true;
let talkLockBusy = false;
let transcriptionSession = null;
let remoteTranscriptState = null;
let pendingLiveTranscript = null;
let liveTranscriptSendTimer = null;
let liveTranscriptRequestPending = false;
let lastLiveTranscriptSent = "";
let selectedAlertVoice = localStorage.getItem("walkietalkie-alert-voice") === "male" ? "male" : "female";
let currentRoomTheme = localStorage.getItem("walkietalkie-room-theme");
if (!roomThemes.includes(currentRoomTheme)) currentRoomTheme = "roadie";
let roomAlerts = [];
let seenAlertIds = new Set();
let alertsInitialized = false;
let renderedAlertsSignature = "";
let alertAudioContext = null;
let alertAudioLoadPromise = null;
const alertAudioBuffers = new Map();
const alertAudioFiles = {
  male: {
    fuel: "/alerts/fuel-male.wav?v=3",
    stop: "/alerts/stop-male.wav?v=3",
    hazard: "/alerts/hazard-male.wav?v=3",
    hungry: "/alerts/hungry-male.wav?v=3",
  },
  female: {
    fuel: "/alerts/fuel-female.wav",
    stop: "/alerts/stop-female.wav",
    hazard: "/alerts/hazard-female.wav",
    hungry: "/alerts/hungry-female.wav",
  },
};
let alertExpiryTimers = new Map();

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (options.auth && sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, { ...options, headers, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function setConnection(state, label) {
  const pill = $("#connectionPill");
  pill.dataset.state = state;
  $("#connectionLabel").textContent = label;
}

function setPttUnavailable(unavailable) {
  pttButton.disabled = false;
  pttButton.setAttribute("aria-disabled", String(unavailable));
}

function updateLiveTranscript(text) {
  liveTranscript.textContent = String(text || "").trim();
  const visible = Boolean(liveTranscript.textContent);
  liveTranscript.classList.toggle("is-visible", visible);
  liveTranscript.setAttribute("aria-hidden", String(!visible));
}

function clearLiveTranscript() {
  if (!liveTranscript) return;
  liveTranscript.textContent = "";
  liveTranscript.classList.remove("is-visible");
  liveTranscript.setAttribute("aria-hidden", "true");
}

function queueLiveTranscript(text, session) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim().slice(-220);
  if (!normalized || !transmitHeld || !transmitGranted) return;
  pendingLiveTranscript = { text: normalized, code: session.code, token: session.token };
  if (liveTranscriptSendTimer || liveTranscriptRequestPending) return;
  liveTranscriptSendTimer = setTimeout(() => { void flushLiveTranscript(); }, 180);
}

async function flushLiveTranscript() {
  liveTranscriptSendTimer = null;
  const update = pendingLiveTranscript;
  pendingLiveTranscript = null;
  if (!update || update.text === lastLiveTranscriptSent || liveTranscriptRequestPending) return;
  liveTranscriptRequestPending = true;
  lastLiveTranscriptSent = update.text;
  try {
    await request(`/api/rooms/${encodeURIComponent(update.code)}/transcript`, {
      method: "POST",
      headers: { authorization: `Bearer ${update.token}` },
      body: JSON.stringify({ text: update.text }),
    });
  } catch { /* Live text is best effort; the audio and final alert remain separate. */ }
  finally {
    liveTranscriptRequestPending = false;
    if (pendingLiveTranscript && !liveTranscriptSendTimer) {
      liveTranscriptSendTimer = setTimeout(() => { void flushLiveTranscript(); }, 80);
    }
  }
}

function formatCode(code) {
  return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function roomLink(code) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("room", code);
  url.hash = "";
  return url.toString();
}

function setWelcomeError(message = "") {
  welcomeError.textContent = message;
}

function setAlertVoice(voice, { persist = true } = {}) {
  selectedAlertVoice = voice === "male" ? "male" : "female";
  if (persist) localStorage.setItem("walkietalkie-alert-voice", selectedAlertVoice);
  alertVoiceButtons.forEach((button) => {
    const selected = button.dataset.alertVoice === selectedAlertVoice;
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}

function currentName() {
  const name = displayNameInput.value.trim().replace(/\s+/g, " ").slice(0, 24);
  if (name) localStorage.setItem("roadie-name", name);
  return name;
}

function showWelcome(message = "") {
  suppressReconnect = true;
  reconnectWake?.();
  welcomeView.hidden = false;
  roomView.hidden = true;
  themePicker.hidden = true;
  themeMenu.hidden = true;
  themeToggle.setAttribute("aria-expanded", "false");
  delete document.documentElement.dataset.roomTheme;
  roomAlerts = [];
  remoteTranscriptState = null;
  clearLiveTranscript();
  seenAlertIds.clear();
  alertsInitialized = false;
  renderedAlertsSignature = "";
  alertExpiryTimers.forEach(clearTimeout);
  alertExpiryTimers.clear();
  $("#roomAlertFeed").replaceChildren();
  $("#roomAlertFeed").hidden = true;
  $("meta[name='theme-color']").content = "#f2f5ef";
  $("#pageNote").hidden = false;
  displayNameInput.value = localStorage.getItem("roadie-name") || "";
  const queryCode = new URLSearchParams(location.search).get("room");
  if (queryCode) roomCodeInput.value = formatCode(queryCode);
  setWelcomeError(message);
  setConnection("ready", "READY");
}

function showRoomShell(roomInfo) {
  currentRoom = roomInfo;
  welcomeView.hidden = true;
  roomView.hidden = false;
  themePicker.hidden = false;
  updateRoomTheme(currentRoomTheme);
  $("#pageNote").hidden = true;
  $("#roomTitle").textContent = roomInfo.name;
  $("#roomCodeLabel").textContent = roomInfo.displayCode;
  $("#inviteCodeLabel").textContent = roomInfo.displayCode;
  $("#crewList").replaceChildren();
  $("#crewCount").textContent = "1";
  roomAlerts = [];
  remoteTranscriptState = null;
  clearLiveTranscript();
  seenAlertIds.clear();
  alertsInitialized = false;
  renderedAlertsSignature = "";
  alertExpiryTimers.forEach(clearTimeout);
  alertExpiryTimers.clear();
  $("#roomAlertFeed").replaceChildren();
  $("#roomAlertFeed").hidden = true;
}

async function createRoom() {
  const name = currentName();
  if (!name) return setWelcomeError("Enter your name so your crew knows who’s talking.");
  setWelcomeError("");
  const button = $("#createRoomButton");
  button.disabled = true;
  button.textContent = "Setting up your room…";
  try {
    const session = await request("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, roomName: $("#roomNameInput").value.trim() }),
    });
    await connectRoom(session, name);
  } catch (error) {
    setWelcomeError(error.message);
    setConnection("error", "OFFLINE");
  } finally {
    button.disabled = false;
    button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>Create a room';
  }
}

async function joinRoom(codeValue = roomCodeInput.value, nameValue = displayNameInput.value) {
  const name = nameValue.trim().replace(/\s+/g, " ").slice(0, 24);
  const code = String(codeValue).replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!name) return setWelcomeError("Enter your name so your crew knows who’s talking.");
  if (code.length !== 8 && code.length !== 16) return setWelcomeError("Enter the full 8-character invite code.");
  localStorage.setItem("roadie-name", name);
  setWelcomeError("");
  const button = $("#joinRoomButton");
  button.disabled = true;
  try {
    const session = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await connectRoom(session, name);
  } catch (error) {
    setWelcomeError(error.message);
    setConnection("error", "OFFLINE");
  } finally {
    button.disabled = false;
  }
}

async function resumeLastRoom(savedRoom) {
  const code = String(savedRoom.code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  const name = String(savedRoom.displayName || "").trim().slice(0, 24);
  if ((code.length !== 8 && code.length !== 16) || !name) {
    localStorage.removeItem("roadie-last-room");
    return showWelcome();
  }
  suppressReconnect = false;
  stateFailureCount = 0;
  roomStateHealthy = false;
  localStorage.setItem("roadie-name", name);
  showRoomShell({
    code,
    displayCode: formatCode(code),
    name: String(savedRoom.name || "Your room"),
  });
  setPttUnavailable(true);
  setConnection("connecting", "RECONNECTING");
  pttHint.textContent = "Rejoining your last room…";

  let attempt = 0;
  while (!suppressReconnect && currentRoom?.code === code) {
    if (!navigator.onLine) {
      setConnection("error", "OFFLINE");
      pttHint.textContent = "You’re offline. Waiting for a connection…";
      await waitForReconnect(30000);
      continue;
    }
    try {
      const session = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (suppressReconnect || currentRoom?.code !== code) return;
      await connectRoom(session, name);
      return;
    } catch (error) {
      if (error.status === 404) {
        localStorage.removeItem("roadie-last-room");
        await finishRoomLocally("Your last room is no longer available.");
        return;
      }
      attempt += 1;
      setConnection("connecting", navigator.onLine ? "RETRYING" : "OFFLINE");
      pttHint.textContent = "Couldn’t rejoin yet. Retrying automatically…";
      await waitForReconnect(Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4)));
    }
  }
}

function installRoomEvents(room) {
  const { RoomEvent, Track } = livekitSdk;
  room.on(RoomEvent.ParticipantConnected, renderCrew);
  room.on(RoomEvent.ParticipantDisconnected, renderCrew);
  room.on(RoomEvent.TrackSubscribed, (track, _publication, _participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    element.muted = !speakerOn;
    $("#audioMount").append(element);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    for (const element of track.detach()) element.remove();
  });
  const markReconnecting = () => {
    if (liveRoom !== room || suppressReconnect) return;
    roomStateHealthy = false;
    setConnection("connecting", "RECONNECTING");
    setPttUnavailable(true);
    pttHint.textContent = "Connection interrupted. Reconnecting…";
    void releaseTalk(false);
  };
  room.on(RoomEvent.Reconnecting, markReconnecting);
  room.on(RoomEvent.SignalReconnecting, markReconnecting);
  room.on(RoomEvent.ConnectionStateChanged, (state) => {
    if (state === "reconnecting" || state === "signalReconnecting") {
      markReconnecting();
    } else if (state === "connected" && liveRoom === room && !reconnectLoopPromise) {
      if (roomStateHealthy) {
        setConnection("connected", "CONNECTED");
        setPttUnavailable(!localMic);
        pttHint.textContent = localMic ? "Press and hold while you talk" : "Allow microphone access to talk";
      }
    }
  });
  room.on(RoomEvent.Reconnected, () => {
    if (liveRoom !== room || suppressReconnect) return;
    if (roomStateHealthy) {
      setConnection("connected", "CONNECTED");
      setPttUnavailable(!localMic);
      pttHint.textContent = localMic ? "Press and hold while you talk" : "Allow microphone access to talk";
    }
    void refreshRoomState();
  });
  room.on(RoomEvent.Disconnected, () => {
    if (liveRoom !== room || suppressReconnect) return;
    setPttUnavailable(true);
    setConnection("connecting", "RECONNECTING");
    pttHint.textContent = "Connection lost. Trying to rejoin…";
    void recoverRoomConnection(room);
  });
}

async function prepareMicrophone() {
  try {
    if (!localMic || localMic.mediaStreamTrack?.readyState !== "live") {
      localMic?.stop();
      localMic = await livekitSdk.createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    }
    await localMic.mute();
    const unavailable = !liveRoom || liveRoom.state !== "connected" || !roomStateHealthy;
    setPttUnavailable(unavailable);
    pttHint.textContent = unavailable
      ? "Reconnecting to your crew…"
      : "Press and hold while you talk";
    $("#retryMicrophone").hidden = true;
    return true;
  } catch (error) {
    localMic = null;
    setPttUnavailable(true);
    pttHint.textContent = "Your radio is connected. Enable the mic to talk.";
    $("#retryMicrophone").hidden = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      liveMessage.replaceChildren(document.createTextNode("Mic needs HTTPS here. "));
      const certificateLink = document.createElement("a");
      certificateLink.href = `http://${location.hostname}:4174/`;
      if (currentRoom?.code) certificateLink.search = `?room=${encodeURIComponent(currentRoom.code)}`;
      certificateLink.textContent = "Install the local certificate";
      liveMessage.append(certificateLink, document.createTextNode(", then reopen the secure link."));
    } else {
      liveMessage.textContent = error.name === "NotAllowedError" ? "Microphone permission is needed to use Talk." : "Could not start the microphone on this device.";
    }
    return false;
  }
}

async function connectRoom(session, name, { recovering = false } = {}) {
  setConnection("connecting", recovering ? "RECONNECTING" : "CONNECTING");
  livekitSdk ||= await import("livekit-client");
  const { Room } = livekitSdk;
  const saved = { code: session.room.code, name: session.room.name, displayName: name };
  if (!recovering) {
    suppressReconnect = false;
    stateFailureCount = 0;
    showRoomShell(session.room);
  } else {
    currentRoom = session.room;
  }
  roomStateHealthy = false;
  sessionToken = session.sessionToken;
  localStorage.setItem("roadie-last-room", JSON.stringify(saved));
  history.replaceState(null, "", roomLink(session.room.code));

  const room = new Room({ adaptiveStream: false, dynacast: false });
  liveRoom = room;
  installRoomEvents(room);
  try {
    await room.connect(session.livekit.url, session.livekit.token);
    if (stateFailureCount < 2) setConnection("connected", "CONNECTED");
    else setConnection("connecting", "RECONNECTING");
    $("#roomConnectionText").textContent = "CONNECTED TO YOUR CREW";
    try { await room.startAudio(); } catch { /* playback can be resumed with the first user gesture */ }
    await prepareMicrophone();
    if (recovering) setPttUnavailable(true);
    renderCrew();
    await refreshRoomState();
    if (currentRoom?.code !== session.room.code || liveRoom !== room) return;
    clearInterval(statePoll);
    statePoll = setInterval(() => { void refreshRoomState(); }, 1000);
  } catch (error) {
    if (liveRoom === room) liveRoom = null;
    try { await room.disconnect(false); } catch { /* already disconnected */ }
    if (recovering) throw error;
    setPttUnavailable(true);
    setConnection("connecting", "RECONNECTING");
    pttHint.textContent = "Connection interrupted. Reconnecting…";
    void recoverRoomConnection(room);
  }
}

function waitForReconnect(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      reconnectWake = null;
      resolve();
    }, delayMs);
    reconnectWake = () => {
      clearTimeout(timer);
      reconnectWake = null;
      resolve();
    };
  });
}

async function recoverRoomConnection(failedRoom = liveRoom) {
  if (suppressReconnect || !currentRoom) return;
  if (reconnectLoopPromise) return reconnectLoopPromise;
  const roomCode = currentRoom.code;
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem("roadie-last-room") || "null"); }
    catch { return null; }
  })();
  const name = localStorage.getItem("roadie-name") || saved?.displayName;
  if (!name) return finishRoomLocally("Reconnect with your invite code to rejoin.");

  clearInterval(statePoll);
  statePoll = null;
  roomStateHealthy = false;
  setPttUnavailable(true);
  setConnection("connecting", navigator.onLine ? "RECONNECTING" : "OFFLINE");
  pttHint.textContent = navigator.onLine
    ? "Connection lost. Rejoining automatically…"
    : "You’re offline. Waiting for a connection…";
  void releaseTalk(false);

  reconnectLoopPromise = (async () => {
    let attempt = 0;
    let roomToClose = failedRoom;
    while (!suppressReconnect && currentRoom?.code === roomCode) {
      if (!navigator.onLine) {
        setConnection("error", "OFFLINE");
        pttHint.textContent = "You’re offline. Waiting for a connection…";
        await waitForReconnect(30000);
        continue;
      }

      if (attempt > 0) {
        const retryDelay = Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4));
        setConnection("connecting", "RETRYING");
        pttHint.textContent = "Connection lost. Retrying automatically…";
        await waitForReconnect(retryDelay);
        if (suppressReconnect || currentRoom?.code !== roomCode) return;
        if (!navigator.onLine) continue;
      }

      try {
        if (roomToClose) {
          if (liveRoom === roomToClose) liveRoom = null;
          await roomToClose.disconnect(false).catch(() => {});
          document.querySelectorAll("#audioMount audio").forEach((element) => element.remove());
          roomToClose = null;
        }
        if (localMic) await localMic.mute().catch(() => {});
        const session = await request(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        if (suppressReconnect || currentRoom?.code !== roomCode) return;
        await connectRoom(session, name, { recovering: true });
        if (currentRoom?.code !== roomCode || suppressReconnect) return;
        if (liveRoom?.state === "connected") {
        if (roomStateHealthy) {
            setConnection("connected", "CONNECTED");
            setPttUnavailable(!localMic);
            pttHint.textContent = localMic ? "Press and hold while you talk" : "Allow microphone access to talk";
          } else {
            setConnection("connecting", "RECONNECTING");
            setPttUnavailable(true);
            pttHint.textContent = "Voice is back. Reconnecting to room controls…";
          }
          return;
        }
        throw new Error("The radio connection dropped again.");
      } catch (error) {
        if (error.status === 404) {
          await finishRoomLocally("This room is no longer available.");
          return;
        }
        if (suppressReconnect || currentRoom?.code !== roomCode) return;
        attempt += 1;
        setConnection("connecting", navigator.onLine ? "RETRYING" : "OFFLINE");
        pttHint.textContent = navigator.onLine
          ? "Couldn’t reconnect yet. Retrying automatically…"
          : "You’re offline. Waiting for a connection…";
      }
    }
  })().finally(() => {
    reconnectLoopPromise = null;
  });
  return reconnectLoopPromise;
}

function renderCrew() {
  if (!liveRoom) return;
  const people = [liveRoom.localParticipant, ...liveRoom.remoteParticipants.values()]
    .filter((person) => person.identity)
    .sort((a, b) => Number(a.identity !== liveRoom.localParticipant.identity) - Number(b.identity !== liveRoom.localParticipant.identity) || (a.name || "").localeCompare(b.name || ""));
  const list = $("#crewList");
  const rows = people.map((person) => {
    const isLocal = person.identity === liveRoom.localParticipant.identity;
    const isTalker = floorState?.identity === person.identity;
    const item = document.createElement("li");
    item.className = "crew-member";
    const avatar = document.createElement("span");
    avatar.className = `avatar ${avatarClass(person.identity)}`;
    avatar.textContent = (person.name || "?").trim().charAt(0).toUpperCase() || "?";
    const info = document.createElement("span");
    info.className = "member-info";
    const nameLine = document.createElement("strong");
    nameLine.textContent = person.name || "Crew member";
    if (isLocal) {
      const you = document.createElement("span");
      you.className = "you-tag";
      you.textContent = "YOU";
      nameLine.append(" ", you);
    }
    const subline = document.createElement("small");
    subline.textContent = isLocal ? "Your radio" : "In this room";
    info.append(nameLine, subline);
    const state = document.createElement("span");
    state.className = "member-state";
    const presence = document.createElement("span");
    presence.className = `presence${isTalker ? " presence-live" : ""}`;
    state.append(presence, document.createTextNode(isTalker ? "On air" : "Listening"));
    item.append(avatar, info, state);
    return item;
  });
  list.replaceChildren(...rows);
  $("#crewCount").textContent = String(people.length);
}

function avatarClass(identity) {
  const classes = ["avatar-sage", "avatar-lilac", "avatar-apricot"];
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return classes[Math.abs(hash) % classes.length];
}

async function refreshRoomState() {
  if (!currentRoom || !sessionToken || stateRequestInFlight) return false;
  const roomCode = currentRoom.code;
  stateRequestInFlight = true;
  try {
    const data = await request(`/api/rooms/${roomCode}/state`, { auth: true });
    if (currentRoom?.code !== roomCode) return false;
    if (data.ended) {
      await finishRoomLocally("This room was ended by a crew member.");
      return false;
    }
    stateFailureCount = 0;
    roomStateHealthy = true;
    floorState = data.talker;
    remoteTranscriptState = data.liveTranscript || null;
    updateRoomAlerts(data.alerts || []);
    updateFloorUI();
    renderCrew();
    if (liveRoom?.state === "connected" && !suppressReconnect) {
      setConnection("connected", "CONNECTED");
      setPttUnavailable(!localMic);
      pttHint.textContent = localMic ? "Press and hold while you talk" : "Allow microphone access to talk";
    }
    return true;
  } catch (error) {
    if (currentRoom?.code !== roomCode) return false;
    if (error.message.includes("session expired")) {
      roomStateHealthy = false;
      setPttUnavailable(true);
      setConnection("connecting", "RECONNECTING");
      pttHint.textContent = "Refreshing your room connection…";
      void recoverRoomConnection(liveRoom);
    } else {
      stateFailureCount += 1;
      if (stateFailureCount >= 2) {
        roomStateHealthy = false;
        setPttUnavailable(true);
        setConnection("connecting", navigator.onLine ? "RECONNECTING" : "OFFLINE");
        pttHint.textContent = navigator.onLine
          ? "Trying to reach your crew…"
          : "You’re offline. Waiting for a connection…";
        if (transmitHeld || transmitGranted) void releaseTalk(false);
      }
    }
    return false;
  } finally {
    stateRequestInFlight = false;
  }
}

function updateRoomAlerts(alerts) {
  const incoming = alerts.filter((alert) => !seenAlertIds.has(alert.id));
  incoming.forEach(scheduleAlertExpiry);
  if (alertsInitialized) {
    incoming
      .filter((alert) => alert.type !== "transcript" && alert.identity !== liveRoom?.localParticipant.identity)
      .forEach(announceRoomAlert);
  }
  roomAlerts = alerts;
  seenAlertIds = new Set(alerts.map((alert) => alert.id));
  alertsInitialized = true;
  renderRoomAlerts();
}

function scheduleAlertExpiry(alert) {
  if (alertExpiryTimers.has(alert.id)) return;
  const expiresIn = Math.max(0, Date.parse(alert.createdAt) + 60000 - Date.now());
  const timer = setTimeout(() => {
    roomAlerts = roomAlerts.filter((item) => item.id !== alert.id);
    alertExpiryTimers.delete(alert.id);
    renderRoomAlerts();
  }, expiresIn);
  alertExpiryTimers.set(alert.id, timer);
}

function renderRoomAlerts() {
  const feed = $("#roomAlertFeed");
  const previousScrollTop = feed.scrollTop;
  const wasFollowingLatest = feed.hidden || previousScrollTop <= 24;
  const signature = JSON.stringify(roomAlerts);
  feed.hidden = roomAlerts.length === 0;
  if (signature === renderedAlertsSignature) return;
  renderedAlertsSignature = signature;
  const rows = roomAlerts.slice().reverse().map((alert) => {
    const item = document.createElement("article");
    item.className = "room-alert-item";
    if (alert.type === "transcript") item.dataset.kind = "transcript";
    const copy = document.createElement("div");
    copy.className = "room-alert-copy";
    const label = document.createElement("strong");
    label.textContent = alert.label;
    const details = document.createElement("small");
    const time = new Date(alert.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const acknowledgements = alert.acknowledgedBy || [];
    const ackCount = acknowledgements.length;
    details.textContent = `${alert.name} · ${time}${ackCount ? ` · ${ackCount} acknowledged` : ""}`;
    copy.append(label, details);
    const isSender = alert.identity === liveRoom?.localParticipant.identity;
    item.append(copy);
    const acknowledged = acknowledgements.includes(liveRoom?.localParticipant.identity);
    if (!isSender && alert.type !== "transcript" && !acknowledged) {
      const ackButton = document.createElement("button");
      ackButton.className = "alert-ack-button";
      ackButton.type = "button";
      ackButton.textContent = "Acknowledge";
      ackButton.addEventListener("click", () => { void acknowledgeAlert(alert.id); });
      item.append(ackButton);
    }
    return item;
  });
  feed.replaceChildren(...rows);
  if (wasFollowingLatest) feed.scrollTop = 0;
  else feed.scrollTop = Math.min(previousScrollTop, Math.max(0, feed.scrollHeight - feed.clientHeight));
}

function playAlertChime() {
  if (!speakerOn) return;
  const context = ensureAlertAudioContext();
  if (!context) return;
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, now);
    oscillator.frequency.setValueAtTime(990, now + 0.11);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    oscillator.connect(gain);
    gain.connect(context.destination);
    if (context.state === "suspended") void context.resume();
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  } catch { /* Browser audio may require another user gesture. */ }
}

function ensureAlertAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  alertAudioContext ||= new AudioContextClass();
  return alertAudioContext;
}

function unlockAlertAudio() {
  const context = ensureAlertAudioContext();
  if (!context) return;
  if (context.state === "suspended") void context.resume().catch(() => {});
  void preloadAlertAudio();
}

function preloadAlertAudio() {
  const context = ensureAlertAudioContext();
  if (!context) return Promise.resolve();
  if (alertAudioLoadPromise) return alertAudioLoadPromise;
  const assets = Object.entries(alertAudioFiles).flatMap(([voice, files]) =>
    Object.entries(files).map(async ([type, path]) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error("Alert audio could not be loaded.");
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      alertAudioBuffers.set(`${voice}:${type}`, buffer);
    }),
  );
  alertAudioLoadPromise = Promise.all(assets).catch(() => {
    alertAudioLoadPromise = null;
  });
  return alertAudioLoadPromise;
}

async function playAlertVoice(alert) {
  if (!speakerOn) return;
  const context = ensureAlertAudioContext();
  if (!context) return;
  const voice = alert.voice === "male" ? "male" : "female";
  const bufferKey = `${voice}:${alert.type}`;
  if (!alertAudioBuffers.has(bufferKey)) await preloadAlertAudio();
  const buffer = alertAudioBuffers.get(bufferKey);
  if (buffer) {
    if (context.state === "suspended") {
      try { await context.resume(); } catch { /* iOS may need a user gesture first. */ }
    }
    if (context.state !== "running" || !speakerOn) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    return;
  }
  const Utterance = window.SpeechSynthesisUtterance;
  if (!Utterance || !window.speechSynthesis) return;
  const utterance = new Utterance(alert.label);
  utterance.rate = 0.96;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

function announceRoomAlert(alert) {
  if (!speakerOn) return;
  playAlertChime();
  setTimeout(() => { void playAlertVoice(alert); }, 320);
}

async function sendQuickAlert(type) {
  if (!currentRoom || !sessionToken) return;
  const buttons = [...document.querySelectorAll(".quick-alert-button")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await request(`/api/rooms/${currentRoom.code}/alerts`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ type, voice: selectedAlertVoice }),
    });
    notify("Alert sent to your crew.");
    await refreshRoomState();
  } catch (error) {
    notify(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function acknowledgeAlert(alertId) {
  if (!currentRoom || !sessionToken) return;
  try {
    await request(`/api/rooms/${currentRoom.code}/alerts/${encodeURIComponent(alertId)}`, {
      method: "POST",
      auth: true,
    });
    await refreshRoomState();
  } catch (error) {
    notify(error.message);
  }
}

function updateFloorUI() {
  const talker = floorState;
  const isMe = talker && liveRoom?.localParticipant.identity === talker.identity;
  if (talker && !isMe) {
    const text = remoteTranscriptState?.identity === talker.identity ? remoteTranscriptState.text : "";
    updateLiveTranscript(text || "Listening");
  } else {
    clearLiveTranscript();
  }
  if (talker) {
    transmitCaption.textContent = isMe ? "YOU'RE ON THE AIR" : `${talker.name.toUpperCase()} IS TALKING`;
    transmitCaption.dataset.state = isMe ? "talking" : "busy";
    $("#channelStatus").textContent = isMe ? "YOU'RE ON AIR" : "CHANNEL BUSY";
    $("#channelStatus").dataset.state = "busy";
    pttButton.classList.toggle("is-busy", !isMe && !transmitHeld);
    pttHint.textContent = isMe ? "Release when you’re done" : "Channel busy — try again in a moment";
  } else {
    transmitCaption.textContent = "CHANNEL IS CLEAR";
    delete transmitCaption.dataset.state;
    $("#channelStatus").textContent = "CLEAR";
    delete $("#channelStatus").dataset.state;
    pttButton.classList.remove("is-busy");
    pttHint.textContent = localMic ? "Press and hold while you talk" : "Allow microphone access to talk";
  }
  renderCrew();
}

function startVoiceTranscription() {
  if (!VOICE_TO_TEXT_ENABLED || transcriptionSession) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  clearTimeout(liveTranscriptSendTimer);
  liveTranscriptSendTimer = null;
  pendingLiveTranscript = null;
  lastLiveTranscriptSent = "";

  const session = {
    code: currentRoom?.code,
    token: sessionToken,
    parts: [],
    restarts: 0,
    recognition: null,
    stopRequested: false,
    publish: true,
    restartTimer: null,
  };
  transcriptionSession = session;

  const startRecognition = () => {
    if (transcriptionSession !== session || session.stopRequested || !transmitHeld || !transmitGranted) return;
    const recognition = new SpeechRecognition();
    session.recognition = recognition;
    recognition.lang = document.documentElement.lang || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    session.partial = "";
    recognition.onresult = (event) => {
      session.partial = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript?.trim();
        if (result.isFinal && transcript) session.parts.push(transcript);
        else if (transcript) session.partial += `${session.partial ? " " : ""}${transcript}`;
      }
      queueLiveTranscript([...session.parts, session.partial].filter(Boolean).join(" "), session);
    };
    recognition.onerror = () => {};
    recognition.onend = () => {
      if (transcriptionSession !== session) return;
      session.recognition = null;
      if (session.stopRequested) {
        finishVoiceTranscription(session);
      } else if (transmitHeld && transmitGranted && session.restarts < 4) {
        session.restarts += 1;
        session.restartTimer = setTimeout(startRecognition, 150);
      }
    };
    try {
      const track = localMic?.mediaStreamTrack;
      if (track) recognition.start(track);
      else recognition.start();
    } catch {
      try { recognition.start(); }
      catch {
        session.recognition = null;
      }
    }
  };

  startRecognition();
}

function finishVoiceTranscription(session) {
  if (transcriptionSession !== session) return;
  transcriptionSession = null;
  clearTimeout(session.restartTimer);
  const text = session.parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!session.publish || !text || !session.code || !session.token) return;
  void request(`/api/rooms/${encodeURIComponent(session.code)}/alerts`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ type: "transcript", text }),
  }).catch(() => {});
}

function stopVoiceTranscription(publish) {
  const session = transcriptionSession;
  clearTimeout(liveTranscriptSendTimer);
  liveTranscriptSendTimer = null;
  pendingLiveTranscript = null;
  if (!session) return;
  session.publish = publish;
  session.stopRequested = true;
  clearTimeout(session.restartTimer);
  if (!session.recognition) {
    finishVoiceTranscription(session);
    return;
  }
  try { session.recognition.stop(); }
  catch { finishVoiceTranscription(session); }
  setTimeout(() => finishVoiceTranscription(session), 1800);
}

async function beginTransmit() {
  if (talkLockBusy || transmitHeld || !liveRoom || liveRoom.state !== "connected" || !localMic || !currentRoom || !roomStateHealthy || stateFailureCount >= 2) return;
  transmitHeld = true;
  const attempt = ++transmitAttempt;
  talkLockBusy = true;
  pttButton.classList.remove("is-busy");
  pttButton.classList.add("is-transmitting");
  pttButton.setAttribute("aria-pressed", "true");
  pttHint.textContent = "Requesting the talk channel…";
  liveMessage.textContent = "";
  try {
    const grant = await request(`/api/rooms/${currentRoom.code}/talk`, { method: "POST", auth: true });
    if (!transmitHeld || attempt !== transmitAttempt) {
      await request(`/api/rooms/${currentRoom.code}/talk`, { method: "DELETE", auth: true }).catch(() => {});
      return;
    }
    floorState = grant.talker;
    await localMic.unmute();
    await liveRoom.localParticipant.publishTrack(localMic, { name: "walkie-talkie", source: livekitSdk.Track.Source.Microphone });
    transmitGranted = true;
    startVoiceTranscription();
    pttHint.textContent = "Release to finish your message";
    updateFloorUI();
    clearInterval(transmitHeartbeat);
    transmitHeartbeat = setInterval(() => { void renewTalkLock(); }, 1800);
  } catch (error) {
    transmitHeld = false;
    pttButton.classList.remove("is-transmitting");
    pttButton.setAttribute("aria-pressed", "false");
    transmitGranted = false;
    clearInterval(transmitHeartbeat);
    if (currentRoom && sessionToken) {
      await request(`/api/rooms/${currentRoom.code}/talk`, { method: "DELETE", auth: true }).catch(() => {});
    }
    if (localMic) await localMic.mute().catch(() => {});
    if (error.message.includes("busy")) {
      liveMessage.textContent = "Someone else has the channel. Try again when it clears.";
      await refreshRoomState();
    } else if (error.message !== "Channel busy.") {
      liveMessage.textContent = error.message;
    }
  } finally {
    talkLockBusy = false;
  }
}

async function renewTalkLock() {
  if (!transmitHeld || !transmitGranted || !currentRoom) return;
  try {
    const data = await request(`/api/rooms/${currentRoom.code}/talk`, { method: "POST", auth: true });
    floorState = data.talker;
  } catch {
    await releaseTalk(false);
    liveMessage.textContent = "Talk channel lost. Your microphone is muted.";
  }
}

async function releaseTalk(showClear = true) {
  const wasHeld = transmitHeld || transmitGranted;
  transmitHeld = false;
  stopVoiceTranscription(showClear && wasHeld);
  transmitAttempt++;
  clearInterval(transmitHeartbeat);
  transmitHeartbeat = null;
  if (transmitGranted && localMic && liveRoom) {
    try { await localMic.mute(); } catch { /* track may already be stopped */ }
    try { await liveRoom.localParticipant.unpublishTrack(localMic, false); } catch { /* track may already be unpublished */ }
  }
  transmitGranted = false;
  pttButton.classList.remove("is-transmitting");
  pttButton.setAttribute("aria-pressed", "false");
  if (currentRoom && sessionToken) {
    await request(`/api/rooms/${currentRoom.code}/talk`, { method: "DELETE", auth: true }).catch(() => {});
  }
  if (showClear && wasHeld) {
    floorState = null;
    updateFloorUI();
  }
}

async function leaveRoom() {
  suppressReconnect = true;
  reconnectWake?.();
  await releaseTalk(false);
  clearInterval(statePoll);
  statePoll = null;
  if (liveRoom) {
    try { await liveRoom.disconnect(); } catch { /* already disconnected */ }
  }
  localMic?.stop();
  localMic = null;
  liveRoom = null;
  sessionToken = null;
  currentRoom = null;
  localStorage.removeItem("roadie-last-room");
  history.replaceState(null, "", location.pathname);
  showWelcome();
}

async function finishRoomLocally(message) {
  suppressReconnect = true;
  reconnectWake?.();
  await releaseTalk(false);
  clearInterval(statePoll);
  statePoll = null;
  if (liveRoom) {
    try { await liveRoom.disconnect(); } catch { /* already disconnected */ }
  }
  localMic?.stop();
  localMic = null;
  liveRoom = null;
  sessionToken = null;
  currentRoom = null;
  localStorage.removeItem("roadie-last-room");
  history.replaceState(null, "", location.pathname);
  showWelcome(message);
}

async function endRoomForEveryone() {
  if (!currentRoom) return;
  const code = currentRoom.code;
  try {
    await request(`/api/rooms/${code}`, { method: "DELETE", auth: true });
    endRoomModal.close();
    await finishRoomLocally("Room ended. Your crew has been disconnected.");
  } catch (error) {
    endRoomModal.close();
    notify(error.message);
  }
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    notify(message);
  } catch {
    notify(value);
  }
}

function updateRoomTheme(theme) {
  if (!roomThemes.includes(theme)) return;
  currentRoomTheme = theme;
  document.documentElement.dataset.roomTheme = theme;
  $("meta[name='theme-color']").content = themeChromeColors[theme];
  localStorage.setItem("walkietalkie-room-theme", theme);
  themeMenu.querySelectorAll("[data-theme]").forEach((option) => {
    option.setAttribute("aria-checked", String(option.dataset.theme === theme));
  });
}

function closeThemeMenu(returnFocus = false) {
  themeMenu.hidden = true;
  themeToggle.setAttribute("aria-expanded", "false");
  if (returnFocus) themeToggle.focus();
}

function updateSpeaker() {
  speakerOn = !speakerOn;
  $("#speakerToggle").setAttribute("aria-pressed", String(!speakerOn));
  $("#speakerToggle").classList.toggle("is-muted", !speakerOn);
  $("#speakerLabel").textContent = speakerOn ? "Speaker On" : "Speaker Off";
  if (!speakerOn) window.speechSynthesis?.cancel();
  document.querySelectorAll("#audioMount audio").forEach((element) => { element.muted = !speakerOn; });
}

$("#createRoomButton").addEventListener("click", () => { void createRoom(); });
$("#joinRoomButton").addEventListener("click", () => { void joinRoom(); });
$("#roomCodeInput").addEventListener("input", () => {
  const formatted = formatCode(roomCodeInput.value);
  roomCodeInput.value = formatted;
});
roomCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void joinRoom(); }
});
displayNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); $("#createRoomButton").click(); }
});

pttButton.addEventListener("pointerdown", (event) => {
  unlockAlertAudio();
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  pttButton.setPointerCapture?.(event.pointerId);
  void beginTransmit();
});
pttButton.addEventListener("pointerup", () => { void releaseTalk(); });
pttButton.addEventListener("pointercancel", () => { void releaseTalk(); });
pttButton.addEventListener("lostpointercapture", () => { void releaseTalk(); });
pttButton.addEventListener("keydown", (event) => {
  if ((event.code === "Space" || event.code === "Enter") && !event.repeat) {
    event.preventDefault();
    void beginTransmit();
  }
});
pttButton.addEventListener("keyup", (event) => {
  if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); void releaseTalk(); }
});
pttButton.addEventListener("blur", () => { void releaseTalk(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && transmitHeld) {
    void releaseTalk();
    liveMessage.textContent = "Talk stopped while the app is in the background.";
  } else if (!document.hidden && currentRoom) {
    if (liveRoom?.state === "disconnected") void recoverRoomConnection(liveRoom);
    else void refreshRoomState();
  }
});

window.addEventListener("offline", () => {
  if (!currentRoom) return;
  roomStateHealthy = false;
  setPttUnavailable(true);
  setConnection("error", "OFFLINE");
  pttHint.textContent = "You’re offline. Waiting for a connection…";
  if (transmitHeld || transmitGranted) void releaseTalk(false);
});
window.addEventListener("online", () => {
  if (!currentRoom) return;
  reconnectWake?.();
  setConnection("connecting", "RECONNECTING");
  setPttUnavailable(true);
  pttHint.textContent = "Network returned. Reconnecting…";
  if (liveRoom?.state === "disconnected") void recoverRoomConnection(liveRoom);
  else void refreshRoomState();
});

document.addEventListener("pointerdown", unlockAlertAudio, { once: true, capture: true });
$("#retryMicrophone").addEventListener("click", () => { void prepareMicrophone(); });
document.querySelectorAll(".quick-alert-button").forEach((button) => {
  button.addEventListener("click", () => { void sendQuickAlert(button.dataset.alertType); });
});
alertVoiceButtons.forEach((button) => {
  button.addEventListener("click", () => setAlertVoice(button.dataset.alertVoice));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = alertVoiceButtons.find((option) => option !== button);
    if (next) {
      setAlertVoice(next.dataset.alertVoice);
      next.focus();
    }
  });
});
setAlertVoice(selectedAlertVoice, { persist: false });
themeToggle.addEventListener("click", () => {
  const open = themeMenu.hidden;
  themeMenu.hidden = !open;
  themeToggle.setAttribute("aria-expanded", String(open));
  if (open) themeMenu.querySelector('[aria-checked="true"]')?.focus();
});
themeMenu.querySelectorAll("[data-theme]").forEach((option) => {
  option.addEventListener("click", () => {
    updateRoomTheme(option.dataset.theme);
    closeThemeMenu(true);
  });
  option.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeThemeMenu(true);
    }
  });
});
document.addEventListener("click", (event) => {
  if (!themePicker.contains(event.target)) closeThemeMenu();
});
themeToggle.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !themeMenu.hidden) {
    event.preventDefault();
    closeThemeMenu(true);
  }
});
$("#speakerToggle").addEventListener("click", updateSpeaker);
$("#inviteTrigger").addEventListener("click", () => inviteModal.showModal());
$("#roomCodeButton").addEventListener("click", () => currentRoom && copyText(currentRoom.displayCode, "Invite code copied"));
$("#copyInvite").addEventListener("click", () => currentRoom && copyText(currentRoom.displayCode, "Invite code copied"));
$("#shareInvite").addEventListener("click", async () => {
  if (!currentRoom) return;
  const link = roomLink(currentRoom.code);
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Join ${currentRoom.name}`,
        text: [
          `Tune in to ${currentRoom.name} on WalkieTalkiePro.`,
          "",
          link,
        ].join("\r\n"),
      });
    }
    catch (error) { if (error.name !== "AbortError") notify("Invite could not be shared."); }
  } else {
    await copyText(link, "Invite link copied");
  }
});
$("#leaveRoomButton").addEventListener("click", () => { void leaveRoom(); });
$("#endRoomButton").addEventListener("click", () => endRoomModal.showModal());
$("#confirmEndRoom").addEventListener("click", () => { void endRoomForEveryone(); });
for (const dialog of [inviteModal, endRoomModal]) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}

const linkedRoom = new URLSearchParams(location.search).get("room");
const lastRoom = (() => { try { return JSON.parse(localStorage.getItem("roadie-last-room") || "null"); } catch { return null; } })();
const rememberedName = localStorage.getItem("roadie-name") || lastRoom?.displayName || "";
displayNameInput.value = rememberedName;
if (linkedRoom) {
  showWelcome();
  roomCodeInput.value = formatCode(linkedRoom);
} else if (lastRoom?.code && lastRoom?.displayName) {
  void resumeLastRoom(lastRoom);
} else {
  showWelcome();
}
