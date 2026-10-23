// Chatter client: Socket.io + plain DOM (all user text is inserted with textContent, never innerHTML)
const $ = (id) => document.getElementById(id);
const socket = io({ autoConnect: true });

const state = { me: null, room: null, rooms: [], typing: new Map(), lastName: "" };
const EMOJI = ["😀", "😂", "😍", "🥳", "😎", "🤔", "😢", "😡", "👍", "👎", "👏", "🙏", "🔥", "🎉", "❤️", "💯", "✅", "👀", "🚀", "☕"];

// ---------- helpers ----------
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const initials = (name) => name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatar(user) {
  const a = el("span", "avatar", initials(user.name));
  a.style.background = user.color;
  return a;
}

// Turn URLs into links without using innerHTML
function linkify(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const a = el("a", "", part);
      a.href = part;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      frag.append(a);
    } else if (part) {
      frag.append(document.createTextNode(part));
    }
  }
  return frag;
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------- messages ----------
const messagesEl = $("messages");
let lastAuthor = null;
let lastAt = 0;

const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
const scrollToBottom = () => {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  $("jumpBtn").hidden = true;
};

function renderMessage(m) {
  if (m.type === "user") messagesEl.querySelector(".empty")?.remove();
  if (m.type === "system") {
    messagesEl.append(el("div", "system", `${m.text} · ${time(m.at)}`));
    lastAuthor = null;
    return;
  }
  const mine = m.user.id === state.me?.id;
  // Group consecutive messages from the same person within 3 minutes
  const grouped = lastAuthor === m.user.id && m.at - lastAt < 3 * 60 * 1000;
  const row = el("div", `msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`);
  if (!grouped) row.append(avatar(m.user));
  else row.append(el("span", "avatar-space"));

  const body = el("div", "msg-body");
  if (!grouped) {
    const head = el("div", "msg-head");
    const name = el("strong", "", mine ? "You" : m.user.name);
    name.style.color = m.user.color;
    head.append(name, el("time", "", time(m.at)));
    body.append(head);
  }
  const bubble = el("div", "bubble");
  bubble.append(linkify(m.text));
  bubble.title = new Date(m.at).toLocaleString();
  body.append(bubble);
  row.append(body);
  messagesEl.append(row);

  lastAuthor = m.user.id;
  lastAt = m.at;
}

function addMessage(m) {
  if (m.room !== state.room) {
    bumpUnread(m.room);
    return;
  }
  const stick = nearBottom() || m.user?.id === state.me?.id;
  renderMessage(m);
  if (stick) scrollToBottom();
  else $("jumpBtn").hidden = false;
}

function renderHistory(history) {
  messagesEl.replaceChildren();
  lastAuthor = null;
  if (!history.length) {
    messagesEl.append(el("div", "empty", `This is the start of #${state.room}. Say hi! 👋`));
  }
  history.forEach(renderMessage);
  scrollToBottom();
}

// ---------- rooms & users ----------
const unread = {};
function bumpUnread(room) {
  unread[room] = (unread[room] ?? 0) + 1;
  renderRooms();
}

function renderRooms() {
  const list = $("roomList");
  list.replaceChildren();
  for (const r of state.rooms) {
    const li = el("li");
    const btn = el("button", `room ${r.name === state.room ? "active" : ""}`);
    btn.append(el("span", "hash", "#"), el("span", "room-name", r.name));
    if (unread[r.name]) btn.append(el("span", "badge", String(unread[r.name])));
    else if (r.online) btn.append(el("span", "online-count", `${r.online}`));
    btn.addEventListener("click", () => switchRoom(r.name));
    li.append(btn);
    list.append(li);
  }

  const select = $("roomSelect");
  if (!state.me) {
    const current = select.value;
    select.replaceChildren(...state.rooms.map((r) => {
      const o = el("option", "", `#${r.name}${r.online ? ` · ${r.online} online` : ""}`);
      o.value = r.name;
      return o;
    }));
    if (current) select.value = current;
  }
}

function renderUsers(users) {
  $("userCount").textContent = users.length;
  $("roomOnline").textContent = `${users.length} online`;
  const list = $("userList");
  list.replaceChildren(
    ...users.map((u) => {
      const li = el("li", "user");
      li.append(avatar(u), el("span", "", u.id === state.me?.id ? `${u.name} (you)` : u.name), el("span", "dot"));
      return li;
    })
  );
}

function switchRoom(name) {
  closeSidebar();
  if (name === state.room) return;
  socket.emit("join", name, (res) => res?.error && toast(res.error));
}

// ---------- typing indicator ----------
function renderTyping() {
  const names = [...state.typing.values()];
  const t = $("typing");
  if (!names.length) return (t.textContent = "");
  t.textContent =
    names.length === 1 ? `${names[0]} is typing…` :
    names.length === 2 ? `${names[0]} and ${names[1]} are typing…` :
    "Several people are typing…";
}

let typingTimer;
let isTyping = false;
$("messageInput").addEventListener("input", () => {
  if (!isTyping) {
    isTyping = true;
    socket.emit("typing", true);
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    socket.emit("typing", false);
  }, 1500);
});

// ---------- socket events ----------
socket.on("rooms", (rooms) => {
  state.rooms = rooms;
  renderRooms();
});

socket.on("joined", ({ room, history, users }) => {
  state.room = room;
  state.typing.clear();
  renderTyping();
  delete unread[room];
  $("roomTitle").textContent = `# ${room}`;
  $("messageInput").placeholder = `Message #${room}`;
  document.title = `#${room} · Chatter`;
  renderRooms();
  renderUsers(users);
  renderHistory(history);
  $("messageInput").focus();
});

socket.on("users", renderUsers);
socket.on("message", addMessage);

socket.on("typing", ({ id, name, typing }) => {
  if (typing) state.typing.set(id, name);
  else state.typing.delete(id);
  renderTyping();
});

socket.on("disconnect", () => {
  $("status").className = "status offline";
  $("status").title = "Reconnecting…";
  if (state.me) toast("Connection lost. Reconnecting…");
});

socket.on("connect", () => {
  $("status").className = "status online";
  $("status").title = "Connected";
  // After a reconnect the server forgot us, so log in again with the same name and room
  if (state.me) {
    const room = state.room;
    socket.emit("login", { name: state.me.name, room }, (res) => {
      if (res.error) return logout(res.error);
      state.me = res.user;
      toast("Reconnected ✓");
    });
  }
});

// ---------- UI events ----------
$("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("nameInput").value;
  const err = $("loginError");
  socket.emit("login", { name, room: $("roomSelect").value }, (res) => {
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      return;
    }
    err.hidden = true;
    state.me = res.user;
    try { localStorage.setItem("chatter:name", res.user.name); } catch { /* ignore */ }
    $("meName").textContent = res.user.name;
    $("meAvatar").replaceWith(Object.assign(avatar(res.user), { id: "meAvatar" }));
    $("login").hidden = true;
    $("chat").hidden = false;
  });
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("message", text, (res) => {
    if (res?.error) toast(res.error);
  });
  input.value = "";
  clearTimeout(typingTimer);
  isTyping = false;
  socket.emit("typing", false);
  $("emojiPanel").hidden = true;
});

$("newRoomForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("newRoomInput");
  const name = input.value.trim();
  if (!name) return;
  socket.emit("join", name, (res) => {
    if (res?.error) toast(res.error);
    else input.value = "";
  });
});

function logout(message) {
  state.me = null;
  state.room = null;
  socket.disconnect();
  socket.connect();
  $("chat").hidden = true;
  $("login").hidden = false;
  if (message) {
    $("loginError").textContent = message;
    $("loginError").hidden = false;
  }
}
$("logoutBtn").addEventListener("click", () => logout());

$("jumpBtn").addEventListener("click", scrollToBottom);
messagesEl.addEventListener("scroll", () => nearBottom() && ($("jumpBtn").hidden = true));

// Emoji picker
const panel = $("emojiPanel");
for (const emoji of EMOJI) {
  const b = el("button", "emoji", emoji);
  b.type = "button";
  b.addEventListener("click", () => {
    const input = $("messageInput");
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
    input.focus();
    input.setSelectionRange(pos + emoji.length, pos + emoji.length);
  });
  panel.append(b);
}
$("emojiBtn").addEventListener("click", () => (panel.hidden = !panel.hidden));
document.addEventListener("click", (e) => {
  if (!panel.hidden && !panel.contains(e.target) && e.target !== $("emojiBtn")) panel.hidden = true;
});

// Mobile sidebar
const openSidebar = () => { $("sidebar").classList.add("open"); $("scrim").hidden = false; };
const closeSidebar = () => { $("sidebar").classList.remove("open"); $("scrim").hidden = true; };
$("menuBtn").addEventListener("click", openSidebar);
$("scrim").addEventListener("click", closeSidebar);

// Remember the last name used
try { $("nameInput").value = localStorage.getItem("chatter:name") ?? ""; } catch { /* ignore */ }
$("nameInput").focus();
