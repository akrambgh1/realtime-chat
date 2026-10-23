import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));

const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 100;
const MAX_MESSAGE = 500;
const MAX_ROOMS = 30;
const DEFAULT_ROOMS = ["general", "random", "tech"];

const app = express();
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(PUBLIC_DIR));
app.get("/health", (_req, res) => res.json({ ok: true, users: users.size, rooms: rooms.size }));

// ---------- in-memory state ----------
/** room name -> { name, history: Message[] } */
const rooms = new Map(DEFAULT_ROOMS.map((name) => [name, { name, history: [] }]));
/** socket id -> { id, name, color, room } */
const users = new Map();

const COLORS = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#0ea5e9", "#8b5cf6", "#ef4444", "#14b8a6"];

const cleanName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
const cleanRoom = (value) =>
  String(value ?? "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

const usersIn = (room) =>
  [...users.values()].filter((u) => u.room === room).map(({ id, name, color }) => ({ id, name, color }));

const roomList = () =>
  [...rooms.values()].map((r) => ({ name: r.name, online: usersIn(r.name).length }));

function pushMessage(room, message) {
  const r = rooms.get(room);
  if (!r) return;
  r.history.push(message);
  if (r.history.length > HISTORY_LIMIT) r.history.shift();
  io.to(room).emit("message", message);
}

const systemMessage = (room, text) =>
  pushMessage(room, { id: randomUUID(), type: "system", text, room, at: Date.now() });

function joinRoom(socket, user, room) {
  if (user.room) {
    socket.leave(user.room);
    socket.to(user.room).emit("typing", { id: user.id, name: user.name, typing: false });
    systemMessage(user.room, `${user.name} left #${user.room}`);
    io.to(user.room).emit("users", usersIn(user.room).filter((u) => u.id !== user.id));
  }
  user.room = room;
  socket.join(room);
  socket.emit("joined", { room, history: rooms.get(room).history, users: usersIn(room) });
  systemMessage(room, `${user.name} joined #${room}`);
  io.to(room).emit("users", usersIn(room));
  io.emit("rooms", roomList());
}

// Very small per-socket rate limit: 8 messages per 5 seconds
function rateLimiter() {
  const stamps = [];
  return () => {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 5000) stamps.shift();
    if (stamps.length >= 8) return false;
    stamps.push(now);
    return true;
  };
}

io.on("connection", (socket) => {
  const allow = rateLimiter();
  socket.emit("rooms", roomList());

  socket.on("login", ({ name, room } = {}, reply = () => {}) => {
    const clean = cleanName(name);
    if (clean.length < 2) return reply({ error: "Pick a name with at least 2 characters." });
    const taken = [...users.values()].some((u) => u.name.toLowerCase() === clean.toLowerCase());
    if (taken) return reply({ error: `“${clean}” is already online. Try another name.` });

    const user = { id: socket.id, name: clean, color: COLORS[users.size % COLORS.length], room: null };
    users.set(socket.id, user);
    reply({ ok: true, user: { id: user.id, name: user.name, color: user.color } });
    joinRoom(socket, user, rooms.has(room) ? room : DEFAULT_ROOMS[0]);
  });

  socket.on("join", (room, reply = () => {}) => {
    const user = users.get(socket.id);
    const name = cleanRoom(room);
    if (!user || !name) return reply({ error: "Invalid room name." });
    if (!rooms.has(name)) {
      if (rooms.size >= MAX_ROOMS) return reply({ error: "Room limit reached." });
      rooms.set(name, { name, history: [] });
    }
    if (user.room !== name) joinRoom(socket, user, name);
    reply({ ok: true, room: name });
  });

  socket.on("message", (text, reply = () => {}) => {
    const user = users.get(socket.id);
    const body = String(text ?? "").trim().slice(0, MAX_MESSAGE);
    if (!user || !body) return reply({ error: "Empty message." });
    if (!allow()) return reply({ error: "Slow down a little!" });
    pushMessage(user.room, {
      id: randomUUID(),
      type: "user",
      text: body,
      room: user.room,
      at: Date.now(),
      user: { id: user.id, name: user.name, color: user.color },
    });
    reply({ ok: true });
  });

  socket.on("typing", (typing) => {
    const user = users.get(socket.id);
    if (user?.room) socket.to(user.room).emit("typing", { id: user.id, name: user.name, typing: Boolean(typing) });
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    if (user.room) {
      socket.to(user.room).emit("typing", { id: user.id, name: user.name, typing: false });
      systemMessage(user.room, `${user.name} left the chat`);
      io.to(user.room).emit("users", usersIn(user.room));
    }
    io.emit("rooms", roomList());
  });
});

server.listen(PORT, () => {
  console.log(`Chatter is running on http://localhost:${PORT}`);
});
