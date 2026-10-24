import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { io as connect } from "socket.io-client";
import { MAX_VOICE, createChatServer } from "../src/chat.js";

let server;
let url;
const sockets = [];

before(async () => {
  ({ server } = createChatServer());
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  sockets.forEach((s) => s.disconnect());
  server.close();
});

// ---------- helpers ----------
const once = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

const ask = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

async function user(name) {
  const socket = connect(url, { transports: ["websocket"], forceNew: true });
  sockets.push(socket);
  await once(socket, "connect");
  const res = await ask(socket, "login", { name });
  assert.equal(res.ok, true, res.error);
  socket.user = res.user;
  return socket;
}

const channel = (list, name) => list.find((c) => c.name === name);

// ---------- chat ----------
describe("chat", () => {
  test("rejects duplicate names and delivers messages", async () => {
    const a = await user("Alice");
    const dupe = connect(url, { transports: ["websocket"], forceNew: true });
    sockets.push(dupe);
    await once(dupe, "connect");
    assert.match((await ask(dupe, "login", { name: "alice" })).error, /already online/);

    const b = await user("Bob");
    const got = once(a, "message");
    // Skip the "Bob joined" system message that may still be in flight
    const waitForUserMessage = new Promise((resolve) => a.on("message", (m) => m.type === "user" && resolve(m)));
    assert.equal((await ask(b, "message", "Hello <b>Alice</b>")).ok, true);
    await got;
    const msg = await waitForUserMessage;
    assert.equal(msg.text, "Hello <b>Alice</b>", "stored as plain text");
    assert.equal(msg.user.name, "Bob");
    a.disconnect();
    b.disconnect();
  });
});

// ---------- voice channels ----------
describe("voice channels", () => {
  test("lists channels to everyone and tracks members", async () => {
    const a = await user("Vera");
    const b = await user("Will");

    const listForB = once(b, "voice:channels");
    const joinA = await ask(a, "voice:join", "lounge");
    assert.equal(joinA.ok, true);
    assert.deepEqual(joinA.peers, [], "first person has nobody to connect to");
    const list = await listForB;
    assert.deepEqual(channel(list, "lounge").members.map((m) => m.name), ["Vera"], "non-members see who is inside");

    // B joins: B gets A as a peer, A is told B arrived
    const arrived = once(a, "voice:peer-joined");
    const joinB = await ask(b, "voice:join", "lounge");
    assert.deepEqual(joinB.peers.map((p) => p.name), ["Vera"]);
    assert.equal((await arrived).name, "Will");

    a.disconnect();
    b.disconnect();
  });

  test("relays WebRTC signals only inside the same channel", async () => {
    const a = await user("Sigrid");
    const b = await user("Theo");
    const outsider = await user("Ursula");
    await ask(a, "voice:join", "gaming");
    await ask(b, "voice:join", "gaming");

    const offer = once(a, "voice:signal");
    b.emit("voice:signal", { to: a.user.id, description: { type: "offer", sdp: "v=0 fake-sdp" } });
    const got = await offer;
    assert.equal(got.from, b.user.id);
    assert.equal(got.description.type, "offer");

    const cand = once(b, "voice:signal");
    a.emit("voice:signal", { to: b.user.id, candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    assert.match((await cand).candidate.candidate, /typ host/);

    // Outsider (not in the channel) and junk payloads are dropped
    let leaked = false;
    a.on("voice:signal", () => (leaked = true));
    outsider.emit("voice:signal", { to: a.user.id, description: { type: "offer", sdp: "x" } });
    b.emit("voice:signal", { to: a.user.id, description: { type: "evil", sdp: "x" } });
    b.emit("voice:signal", { to: a.user.id, hello: "world" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(leaked, false);

    [a, b, outsider].forEach((s) => s.disconnect());
  });

  test("shares mute / deafen state, and deafen also mutes", async () => {
    const a = await user("Mona");
    await ask(a, "voice:join", "study");
    const update = once(a, "voice:channels");
    a.emit("voice:state", { muted: false, deafened: true });
    const me = channel(await update, "study").members.find((m) => m.name === "Mona");
    assert.equal(me.deafened, true);
    assert.equal(me.muted, true);
    a.disconnect();
  });

  test("switching channels and disconnecting notify the others", async () => {
    const a = await user("Nils");
    const b = await user("Olga");
    await ask(a, "voice:join", "lounge");
    await ask(b, "voice:join", "lounge");

    const left = once(a, "voice:peer-left");
    await ask(b, "voice:join", "study"); // switch
    assert.equal((await left).id, b.user.id);

    await ask(b, "voice:join", "lounge");
    const gone = once(a, "voice:peer-left");
    b.disconnect();
    assert.equal((await gone).id, b.user.id);
    a.disconnect();
  });

  test("rejects unknown channels, rejoining, and full channels", async () => {
    const a = await user("Pia");
    assert.match((await ask(a, "voice:join", "secret")).error, /doesn't exist/);
    await ask(a, "voice:join", "gaming");
    assert.match((await ask(a, "voice:join", "gaming")).error, /already in/);

    const extra = [];
    for (let i = 1; i < MAX_VOICE; i++) {
      const s = await user(`Guest ${i}`);
      assert.equal((await ask(s, "voice:join", "gaming")).ok, true);
      extra.push(s);
    }
    const late = await user("Late Larry");
    assert.match((await ask(late, "voice:join", "gaming")).error, /full/);
    [a, late, ...extra].forEach((s) => s.disconnect());
  });
});
