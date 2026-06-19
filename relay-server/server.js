// CodeCanvas relay server
// Minimal WebSocket relay for syncing the code-canvas panel across collaborators
// in the same Excalidraw room. No database - rooms live in memory for the
// lifetime of the process, which is fine for a code snippet relay.
//
// Run locally:   node server.js
// Deploy:        Render / Railway / Fly.io / any host that runs a long-lived
//                Node process (this will NOT work on GitHub Pages, which is
//                static-file-only - that's why this is a separate service).

const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8787;

// room id -> { code: string, clients: Set<ws> }
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { code: null, clients: new Set() };
    rooms.set(roomId, room);
  }
  return room;
}

function broadcast(room, data, exceptWs) {
  const msg = JSON.stringify(data);
  for (const client of room.clients) {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

function sendPeerCount(room) {
  broadcast(room, { type: "peers", count: room.clients.size }, null);
}

// Plain HTTP server so platforms that health-check via HTTP GET don't fail
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("codecanvas relay ok\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let joinedRoom = null;
  let roomId = null;

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      roomId = String(msg.room || "default").slice(0, 300);
      joinedRoom = getRoom(roomId);
      joinedRoom.clients.add(ws);

      // Tell the newcomer the current state of the room (last-write-wins cache)
      ws.send(
        JSON.stringify({
          type: "init",
          code: joinedRoom.code,
        }),
      );
      sendPeerCount(joinedRoom);
      return;
    }

    if (msg.type === "update" && joinedRoom) {
      joinedRoom.code = msg.code;
      broadcast(joinedRoom, { type: "update", code: msg.code }, ws);
      return;
    }
  });

  ws.on("close", () => {
    if (joinedRoom) {
      joinedRoom.clients.delete(ws);
      sendPeerCount(joinedRoom);
      // Clean up empty rooms after a delay (someone might reconnect)
      if (joinedRoom.clients.size === 0) {
        const idRef = roomId;
        setTimeout(() => {
          const r = rooms.get(idRef);
          if (r && r.clients.size === 0) rooms.delete(idRef);
        }, 5 * 60 * 1000);
      }
    }
  });
});

// Heartbeat to drop dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`codecanvas relay listening on :${PORT}`);
});
