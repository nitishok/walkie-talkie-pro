# Roadie Radio

A mobile-first, local-first push-to-talk room for road-trip crews. Guests join with a secret invite code and a name; accounts are not required. The room roster and one-speaker talk floor update live, and voice runs through a self-hosted LiveKit server.

## Start locally

Requirements: Node.js 20+, LiveKit Server, and mkcert. On macOS, install them with `brew install livekit mkcert`.

```sh
npm install
npm run setup:lan-cert
npm run dev
```

Open [http://localhost:4173](http://localhost:4173) on the Mac. From a phone on the same Wi-Fi, open `http://<Mac-LAN-IP>:4174` and install the local certificate, then open `https://<Mac-LAN-IP>:4175` for microphone access. iPhone/iPad users must also enable full trust under Settings → General → About → Certificate Trust Settings. Android users can install the downloaded CA certificate from Security → Encryption & credentials. The dev command starts the web app, HTTPS web app, certificate download page, Node room API, and LiveKit's local development server. Room data is stored in `data/rooms.json`.

## Room behavior

- First visit: enter a name, then create a reusable room or join with its invite code.
- Returning visits: reconnect to the last room automatically.
- Anyone with the invite can join. Any member can end the room for everyone.
- A server-side talk lock allows one person to transmit at a time. Other guests see who has the channel.
- The microphone is requested when a person enters a room. It stays muted until they hold Talk.
- Each member can choose a male or female spoken voice for the quick alerts they send. The choice is saved in that browser and travels with each alert.

Installing the certificate adds trust for certificates signed by this Mac's local development CA. The CA's private key remains on the Mac. Remove the certificate profile from the phone when LAN development is done. The web app requires the page to remain open for reliable audio; background listening is not guaranteed on mobile browsers. Local development uses LiveKit's dev key only; deployment requires a public LiveKit server address and private API/session secrets.
