# 💬 Chatter — Real-time Chat

Chatter is a real-time chat app with text rooms, live online users, typing indicators, message history and **Discord-style voice channels**. Open it in two browser windows and watch messages appear instantly, or hop into 🔊 Lounge and talk.

Built with **Node.js**, **Express** and **Socket.io** on the server, **WebRTC** for voice, and **vanilla JavaScript** (no framework) on the client.

**🔗 Live demo:** https://chatter-realtime-chat.onrender.com/ (free hosting, so the first visit can take about 30 s to wake up)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/akrambgh1/realtime-chat)

## ✨ Features

### 🔊 Voice channels (like Discord)
- **Lounge**, **Gaming** and **Study** voice channels in the sidebar. Click to join, with no calling or ringing.
- Everyone can see **who's in each voice channel**, even before joining.
- **Green speaking ring** around whoever is talking (live volume detection with the Web Audio API)
- **Mute** and **Deafen** (deafen also mutes, and unmuting undeafens, like Discord), shown to everyone as crossed-out icons
- **"Voice Connected" panel** with the channel name, connection status and a disconnect button
- Join and leave sounds, generated in the browser
- Peer-to-peer audio with **WebRTC**: the server only relays the connection setup ("signaling"), never the audio. Up to 8 people per channel, each connected to everyone else.
- Echo cancellation and noise suppression from the browser

### 💬 Text chat
- ⚡ **Instant messaging** over WebSockets (Socket.io)
- \# **Rooms**: #general, #random, #tech, and you can **create your own**
- 🟢 **Online users** in the current room, plus live online counts for every room
- ✍️ **Typing indicator** ("Sam is typing…", "Alex and Sam are typing…")
- 🕘 **Message history**: the last 100 messages per room are sent when you join
- 🔔 **Unread badges** for rooms you're not looking at
- 👋 **System messages** when people join or leave
- 🔗 Links become clickable automatically, and there's an 😊 **emoji picker**
- 🧱 **Message grouping** like Slack and Discord, with a "↓ New messages" button when you've scrolled up
- 🔄 **Auto-reconnect**: if the connection drops, you rejoin the same room
- 🛡️ **Safe by design**: unique names, length limits, per-user rate limiting, and every message rendered as text (never HTML, so no XSS)
- 📱 **Responsive** layout with a slide-out sidebar on mobile

## 🛠️ Tech Stack

| Part | Technology |
|------|------------|
| Server | Node.js + Express |
| Real-time | Socket.io 4 (WebSockets with fallback) |
| Client | HTML, CSS and vanilla JavaScript (DOM APIs only) |
| Hosting | Render (free plan) via `render.yaml` |

## 🚀 Run Locally

```bash
git clone https://github.com/akrambgh1/realtime-chat.git
cd realtime-chat
npm install
npm start
```

Open http://localhost:3000 in **two different browser windows**, join with two names, and chat.

For development with auto-restart: `npm run dev`

## ☁️ Deploy for free (Render)

1. Create a free account at [render.com](https://render.com) and connect your GitHub.
2. Click **New → Blueprint** and pick this repository. Render reads `render.yaml` automatically.
3. Wait for the build, and your chat is live at `https://<name>.onrender.com`.

> On the free plan the server sleeps after 15 minutes without visitors, so the first load can take about 30 seconds.

## 🔌 Socket events

| Event | Direction | Payload |
|-------|-----------|---------|
| `login` | client → server | `{ name, room }` → reply `{ ok, user }` or `{ error }` |
| `join` | client → server | `roomName` → reply `{ ok, room }` |
| `message` | both | text from the client, a message object from the server |
| `typing` | both | `true/false` from the client, `{ id, name, typing }` from the server |
| `joined` | server → client | `{ room, history, users }` |
| `users` / `rooms` | server → client | live lists for the sidebar |
| `voice:join` | client → server | `channel` → reply `{ ok, channel, peers }` |
| `voice:leave` | client → server | none |
| `voice:signal` | both | `{ to, description \| candidate }`, relayed only between members of the same channel |
| `voice:state` | client → server | `{ muted, deafened }` |
| `voice:channels` | server → client | every channel with its members (shown to everyone) |
| `voice:peer-joined` / `voice:peer-left` | server → client | someone entered or left my channel |

### How a voice channel connects

1. You click **🔊 Lounge**, and the browser asks for your microphone.
2. The server adds you to the channel and replies with everyone already inside.
3. **You** send a WebRTC *offer* to each of them, and they answer. Only the newcomer makes offers, so two people never call each other at the same time.
4. Network paths (ICE candidates, found with Google's free STUN servers) are exchanged through the server, and then **audio flows directly between browsers**.

> Some strict networks (some offices or mobile carriers) block direct connections. Those would need a TURN relay server, which isn't included because free TURN services need an account.

## 🧪 Tests

```bash
npm test
```

There are 6 integration tests with real Socket.io clients: duplicate names, message delivery, voice channel membership, signals relayed only within the same channel (and junk dropped), mute/deafen state, switching channels and disconnects, and full channels.

## 📂 Project Structure

```
realtime-chat/
├── server.js          # Starts the server
├── src/
│   └── chat.js        # Express + Socket.io: rooms, history, rate limit, voice signaling
├── public/
│   ├── index.html     # Login screen + chat layout
│   ├── style.css
│   ├── app.js         # Socket client, rendering, typing, emoji, reconnect
│   └── voice.js       # Voice channels: WebRTC mesh, speaking detection, mute/deafen
├── test/chat.test.js
└── render.yaml        # Free hosting config
```

## 📚 What I Learned

- How WebSockets differ from normal HTTP requests
- Socket.io rooms, broadcasts and acknowledgement callbacks
- **WebRTC**: offers and answers, ICE candidates, STUN, and peer-to-peer audio in a mesh
- Measuring live audio volume with the Web Audio API for speaking indicators
- Keeping server state (users, rooms, voice channels) consistent when people join, leave and disconnect
- Preventing XSS by building the DOM with `textContent`, and validating relayed data
- Basic abuse protection: validation and rate limiting

## 📄 License

MIT. Free to use and modify.
