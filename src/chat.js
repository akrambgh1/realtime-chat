import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const HISTORY_LIMIT = 100;
const MAX_MESSAGE = 500;
const MAX_ROOMS = 30;
const DEFAULT_ROOMS = ["general", "random", "tech"];
export const VOICE_CHANNELS = ["lounge", "gaming", "study"];
export const MAX_VOICE = 8; // everyone connects to everyone (mesh), so keep channels small

const COLORS = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#0ea5e9", "#8b5cf6", "#ef4444", "#14b8a6"];

const cleanName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
const cleanRoom = (value) =>
  String(value ?? "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

// Very small per-socket rate limit: `max` events per `windowMs`
function rateLimiter(max = 8, windowMs = 5000) {
  const stamps = [];
  return () => {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
    if (stamps.length >= max) return false;
    stamps.push(now);
    return true;
  };
}

// Only relay well-formed WebRTC signaling data
function cleanSignal(data) {
  if (!data || typeof data !== "object") return null;
  const { description, candidate } = data;
  if (description) {
    if (!["offer", "answer"].includes(description.type) || typeof description.sdp !== "string" || description.sdp.length > 20000) return null;
    return { description: { type: description.type, sdp: description.sdp } };
  }
  if (candidate && typeof candidate === "object" && typeof candidate.candidate === "string" && candidate.candidate.length < 1000) {
    const { sdpMid = null, sdpMLineIndex = null, usernameFragment = null } = candidate;
    return { candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex, usernameFragment } };
  }
  return null;
}

export function createChatServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e5 });

  // ---------- in-memory state ----------
  /** room name -> { name, history: Message[] } */
  const rooms = new Map(DEFAULT_ROOMS.map((name) => [name, { name, history: [] }]));
  /** socket id -> { id, name, color, room, voice, muted, deafened } */
  const users = new Map();

  app.use(express.static(PUBLIC_DIR));
  app.get("/health", (_req, res) => res.json({ ok: true, users: users.size, rooms: rooms.size }));

  const publicUser = ({ id, name, color }) => ({ id, name, color });
  const usersIn = (room) => [...users.values()].filter((u) => u.room === room).map(publicUser);
  const roomList = () => [...rooms.values()].map((r) => ({ name: r.name, online: usersIn(r.name).length }));

  // Everyone sees who is in each voice channel (like Discord), even before joining
  const voiceList = () =>
    VOICE_CHANNELS.map((name) => ({
      name,
      members: [...users.values()]
        .filter((u) => u.voice === name)
        .map((u) => ({ ...publicUser(u), muted: u.muted, deafened: u.deafened })),
    }));
  const broadcastVoice = () => io.emit("voice:channels", voiceList());

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

  function leaveVoice(socket, user) {
    if (!user?.voice) return;
    const channel = `voice:${user.voice}`;
    user.voice = null;
    user.muted = false;
    user.deafened = false;
    socket.leave(channel);
    io.to(channel).emit("voice:peer-left", { id: user.id });
    broadcastVoice();
  }

  io.on("connection", (socket) => {
    const allowMessage = rateLimiter(8, 5000);
    const allowVoice = rateLimiter(10, 10000);
    socket.emit("rooms", roomList());
    socket.emit("voice:channels", voiceList());

    socket.on("login", ({ name, room } = {}, reply = () => {}) => {
      const clean = cleanName(name);
      if (clean.length < 2) return reply({ error: "Pick a name with at least 2 characters." });
      if (users.has(socket.id)) return reply({ error: "You're already logged in." });
      const taken = [...users.values()].some((u) => u.name.toLowerCase() === clean.toLowerCase());
      if (taken) return reply({ error: `“${clean}” is already online. Try another name.` });

      const user = { id: socket.id, name: clean, color: COLORS[users.size % COLORS.length], room: null, voice: null, muted: false, deafened: false };
      users.set(socket.id, user);
      reply({ ok: true, user: publicUser(user) });
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
      if (!allowMessage()) return reply({ error: "Slow down a little!" });
      pushMessage(user.room, {
        id: randomUUID(),
        type: "user",
        text: body,
        room: user.room,
        at: Date.now(),
        user: publicUser(user),
      });
      reply({ ok: true });
    });

    socket.on("typing", (typing) => {
      const user = users.get(socket.id);
      if (user?.room) socket.to(user.room).emit("typing", { id: user.id, name: user.name, typing: Boolean(typing) });
    });

    // ----- voice channels (WebRTC signaling only; audio goes browser to browser) -----
    socket.on("voice:join", (name, reply = () => {}) => {
      const user = users.get(socket.id);
      if (!user) return reply({ error: "Log in first." });
      if (!VOICE_CHANNELS.includes(name)) return reply({ error: "That voice channel doesn't exist." });
      if (user.voice === name) return reply({ error: "You're already in this channel." });
      if (!allowVoice()) return reply({ error: "You're switching channels too fast." });
      const members = [...users.values()].filter((u) => u.voice === name);
      if (members.length >= MAX_VOICE) return reply({ error: `This channel is full (${MAX_VOICE} people max).` });

      leaveVoice(socket, user);
      user.voice = name;
      socket.join(`voice:${name}`);
      // The newcomer starts a connection to everyone already here (avoids both sides calling at once)
      reply({ ok: true, channel: name, peers: members.map(publicUser) });
      socket.to(`voice:${name}`).emit("voice:peer-joined", publicUser(user));
      broadcastVoice();
    });

    socket.on("voice:leave", () => leaveVoice(socket, users.get(socket.id)));

    socket.on("voice:signal", ({ to, ...data } = {}) => {
      const user = users.get(socket.id);
      const peer = users.get(to);
      const signal = cleanSignal(data);
      // Relay only between two people in the same voice channel
      if (!user?.voice || !peer || peer.voice !== user.voice || !signal) return;
      io.to(to).emit("voice:signal", { from: socket.id, ...signal });
    });

    socket.on("voice:state", ({ muted, deafened } = {}) => {
      const user = users.get(socket.id);
      if (!user?.voice) return;
      user.deafened = Boolean(deafened);
      user.muted = Boolean(muted) || user.deafened; // deafening also mutes, like Discord
      broadcastVoice();
    });

    socket.on("disconnect", () => {
      const user = users.get(socket.id);
      if (!user) return;
      leaveVoice(socket, user);
      users.delete(socket.id);
      if (user.room) {
        socket.to(user.room).emit("typing", { id: user.id, name: user.name, typing: false });
        systemMessage(user.room, `${user.name} left the chat`);
        io.to(user.room).emit("users", usersIn(user.room));
      }
      io.emit("rooms", roomList());
    });
  });

  return { app, server, io };
}
