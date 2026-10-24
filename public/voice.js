// Discord-style voice channels with WebRTC.
// Audio goes directly between browsers (a "mesh": everyone connects to everyone);
// the server only passes the connection setup messages ("signaling") along.
// Uses globals from app.js: socket, state, $, el, avatar, toast.

const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const CHANNEL_LABELS = { lounge: "Lounge", gaming: "Gaming", study: "Study" };
const SPEAKING_LEVEL = 0.035; // RMS volume above which someone counts as talking

const voice = {
  channel: null,
  joining: false,
  stream: null, // my microphone
  peers: new Map(), // peer id -> { pc, audio, analyser, pending: [] }
  muted: false,
  deafened: false,
  channels: [],
  speaking: new Set(),
  ctx: null,
  localAnalyser: null,
  loop: null,
};

const audioContext = () => {
  voice.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (voice.ctx.state === "suspended") voice.ctx.resume();
  return voice.ctx;
};

// ---------- little UI sounds (generated, no files) ----------
function blip(freqs) {
  try {
    const ctx = audioContext();
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch {
    /* audio not available */
  }
}
const sounds = {
  join: () => blip([523, 784]),
  leave: () => blip([784, 523]),
  mute: () => blip([440]),
  unmute: () => blip([660]),
};

// ---------- volume analysis for the green "speaking" ring ----------
function analyserFor(stream) {
  const ctx = audioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return analyser;
}

function level(analyser) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / data.length);
}

function speakingLoop() {
  const now = new Set();
  if (voice.localAnalyser && !voice.muted && level(voice.localAnalyser) > SPEAKING_LEVEL) now.add(state.me?.id);
  for (const [id, p] of voice.peers) if (p.analyser && level(p.analyser) > SPEAKING_LEVEL) now.add(id);
  const changed = now.size !== voice.speaking.size || [...now].some((id) => !voice.speaking.has(id));
  voice.speaking = now;
  if (changed) {
    document.querySelectorAll(".vm[data-id]").forEach((n) => n.classList.toggle("speaking", now.has(n.dataset.id)));
  }
}

// ---------- peer connections ----------
function createPeer(id, initiator) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { pc, audio: null, analyser: null, pending: [] };
  voice.peers.set(id, peer);

  voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));

  pc.onicecandidate = (e) => e.candidate && socket.emit("voice:signal", { to: id, candidate: e.candidate.toJSON() });

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!peer.audio) {
      peer.audio = new Audio();
      peer.audio.autoplay = true;
      peer.audio.dataset.peer = id;
      $("voiceAudio").append(peer.audio);
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = voice.deafened;
    peer.audio.play().catch(() => {});
    try {
      peer.analyser = analyserFor(stream);
    } catch {
      /* speaking ring is optional */
    }
  };

  pc.onconnectionstatechange = () => {
    renderVoice();
    if (pc.connectionState === "failed") {
      toast("Couldn't connect audio with someone. Their network may block direct connections.");
    }
  };

  if (initiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => socket.emit("voice:signal", { to: id, description: pc.localDescription.toJSON() }))
      .catch((err) => console.warn("offer failed", err));
  }
  return peer;
}

function closePeer(id) {
  const p = voice.peers.get(id);
  if (!p) return;
  p.pc.close();
  if (p.audio) {
    p.audio.srcObject = null;
    p.audio.remove();
  }
  voice.peers.delete(id);
}

socket.on("voice:signal", async ({ from, description, candidate }) => {
  if (!voice.channel || !voice.stream) return;
  const peer = voice.peers.get(from) ?? createPeer(from, false);
  const { pc } = peer;
  try {
    if (description) {
      await pc.setRemoteDescription(description);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (description.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit("voice:signal", { to: from, description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
      else peer.pending.push(candidate);
    }
  } catch (err) {
    console.warn("signal failed", err);
  }
});

socket.on("voice:peer-joined", () => voice.channel && sounds.join());
socket.on("voice:peer-left", ({ id }) => {
  if (!voice.peers.has(id)) return;
  closePeer(id);
  sounds.leave();
});

socket.on("voice:channels", (channels) => {
  voice.channels = channels;
  renderVoice();
});

// ---------- join / leave ----------
async function joinVoice(name) {
  if (!state.me) return;
  if (voice.channel === name || voice.joining) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    return toast("Your browser doesn't support voice. Try Chrome, Edge or Firefox.");
  }
  voice.joining = true;
  renderVoice();
  try {
    if (!voice.stream) {
      voice.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      voice.localAnalyser = analyserFor(voice.stream);
    }
  } catch {
    voice.joining = false;
    renderVoice();
    return toast("Microphone access is needed to join voice. Allow it in your browser's address bar.");
  }
  applyMute();

  socket.emit("voice:join", name, (res) => {
    voice.joining = false;
    if (res?.error) {
      renderVoice();
      return toast(res.error);
    }
    // Switching channels: drop old connections first
    for (const id of [...voice.peers.keys()]) closePeer(id);
    voice.channel = res.channel;
    socket.emit("voice:state", { muted: voice.muted, deafened: voice.deafened });
    res.peers.forEach((p) => createPeer(p.id, true)); // I connect to everyone already inside
    voice.loop ??= setInterval(speakingLoop, 120);
    sounds.join();
    renderVoice();
  });
}

function leaveVoice({ notify = true, sound = true } = {}) {
  if (!voice.channel && !voice.stream) return;
  if (notify && voice.channel) socket.emit("voice:leave");
  for (const id of [...voice.peers.keys()]) closePeer(id);
  voice.stream?.getTracks().forEach((t) => t.stop()); // turns the mic light off
  voice.stream = null;
  voice.localAnalyser = null;
  clearInterval(voice.loop);
  voice.loop = null;
  voice.speaking.clear();
  if (voice.channel && sound) sounds.leave();
  voice.channel = null;
  renderVoice();
}

// Losing the server connection (or logging out) drops voice too
socket.on("disconnect", () => leaveVoice({ notify: false, sound: false }));

// ---------- mute / deafen ----------
function applyMute() {
  voice.stream?.getAudioTracks().forEach((t) => (t.enabled = !(voice.muted || voice.deafened)));
  for (const p of voice.peers.values()) if (p.audio) p.audio.muted = voice.deafened;
}

function setVoiceState({ muted = voice.muted, deafened = voice.deafened }) {
  const wasMuted = voice.muted || voice.deafened;
  voice.deafened = deafened;
  voice.muted = muted;
  applyMute();
  const nowMuted = voice.muted || voice.deafened;
  if (nowMuted !== wasMuted || deafened) (nowMuted ? sounds.mute : sounds.unmute)();
  if (voice.channel) socket.emit("voice:state", { muted: voice.muted, deafened: voice.deafened });
  renderVoice();
}

$("muteBtn").addEventListener("click", () => {
  // Unmuting while deafened also undeafens, like Discord
  if (voice.deafened) return setVoiceState({ muted: false, deafened: false });
  setVoiceState({ muted: !voice.muted });
});
$("deafenBtn").addEventListener("click", () => setVoiceState({ deafened: !voice.deafened }));
$("vpLeave").addEventListener("click", () => leaveVoice());

// ---------- rendering ----------
const ICON_PATHS = {
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M19 11a7 7 0 0 1-14 0", "M12 18v3", "M8 21h8"],
  headphones: ["M4 15v-3a8 8 0 0 1 16 0v3", "M4 15h3v5H5a1 1 0 0 1-1-1z", "M20 15h-3v5h2a1 1 0 0 0 1-1z"],
};

function icon(name, { struck = false, title = "" } = {}) {
  const wrap = el("span", `vicon ${struck ? "struck" : ""}`);
  if (title) wrap.title = title;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  wrap.append(svg);
  return wrap;
}

$("muteBtn").replaceChildren(icon("mic"));
$("deafenBtn").replaceChildren(icon("headphones"));

function connectionLabel() {
  if (voice.joining) return "Connecting…";
  const states = [...voice.peers.values()].map((p) => p.pc.connectionState);
  if (states.some((s) => s === "failed")) return "Connection problem";
  if (states.some((s) => s === "new" || s === "connecting")) return "Connecting…";
  return "Voice Connected";
}

function renderVoice() {
  const list = $("voiceList");
  list.replaceChildren(
    ...voice.channels.map((ch) => {
      const li = el("li");
      const btn = el("button", `voice-channel ${voice.channel === ch.name ? "active" : ""}`);
      btn.append(el("span", "speaker", "🔊"), el("span", "room-name", CHANNEL_LABELS[ch.name] ?? ch.name));
      if (ch.members.length) btn.append(el("span", "online-count", String(ch.members.length)));
      btn.title = voice.channel === ch.name ? "You're here" : `Join ${CHANNEL_LABELS[ch.name] ?? ch.name}`;
      btn.addEventListener("click", () => {
        closeSidebar?.();
        joinVoice(ch.name);
      });
      li.append(btn);

      if (ch.members.length) {
        const members = el("ul", "voice-members");
        for (const m of ch.members) {
          const row = el("li", `vm ${voice.speaking.has(m.id) ? "speaking" : ""}`);
          row.dataset.id = m.id;
          row.append(avatar(m), el("span", "vm-name", m.id === state.me?.id ? `${m.name} (you)` : m.name));
          if (m.muted) row.append(icon("mic", { struck: true, title: "Muted" }));
          if (m.deafened) row.append(icon("headphones", { struck: true, title: "Deafened" }));
          members.append(row);
        }
        li.append(members);
      }
      return li;
    })
  );

  $("voicePanel").hidden = !voice.channel && !voice.joining;
  $("vpStatus").textContent = connectionLabel();
  $("vpStatus").classList.toggle("warn", connectionLabel() !== "Voice Connected");
  $("vpChannel").textContent = voice.channel ? `🔊 ${CHANNEL_LABELS[voice.channel] ?? voice.channel}` : "";

  const mute = $("muteBtn");
  const deafen = $("deafenBtn");
  const isMuted = voice.muted || voice.deafened;
  mute.classList.toggle("off", isMuted);
  mute.setAttribute("aria-pressed", String(isMuted));
  mute.title = isMuted ? "Unmute" : "Mute";
  deafen.classList.toggle("off", voice.deafened);
  deafen.setAttribute("aria-pressed", String(voice.deafened));
  deafen.title = voice.deafened ? "Undeafen" : "Deafen";
}

renderVoice();
