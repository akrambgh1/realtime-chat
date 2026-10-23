# 💬 Chatter — Real-time Chat

Chatter is a real-time chat app with rooms, live online users, typing indicators and message history. Open it in two browser windows and watch messages appear instantly.

Built with **Node.js**, **Express** and **Socket.io** on the server, and **vanilla JavaScript** (no framework) on the client.

## ✨ Features

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

## 📂 Project Structure

```
realtime-chat/
├── server.js          # Express + Socket.io server, rooms, history, rate limit
├── public/
│   ├── index.html     # Login screen + chat layout
│   ├── style.css
│   └── app.js         # Socket client, rendering, typing, emoji, reconnect
└── render.yaml        # Free hosting config
```

## 📚 What I Learned

- How WebSockets differ from normal HTTP requests
- Socket.io rooms, broadcasts and acknowledgement callbacks
- Keeping server state (users, rooms, history) consistent when people join, leave and disconnect
- Preventing XSS by building the DOM with `textContent`
- Basic abuse protection: validation and rate limiting

## 📄 License

MIT. Free to use and modify.
