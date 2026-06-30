// ==================== CHAT SERVER - OPTIMIZED ====================

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 500,
  MAX_MESSAGE_SIZE: 2000, // ✅ DIKURANGI: 5000 → 2000
  INTERVAL_30_MENIT: 1800000, // ✅ DIUBAH: 15 menit → 30 menit
  MAX_NUMBER: 6,
  BROADCAST_BATCH_SIZE: 20, // ✅ DIKURANGI: 50 → 20
  CLEANUP_INTERVAL: 60000, // ✅ BARU: 60 detik
  MAX_MESSAGES_PER_MINUTE: 60, // ✅ BARU: Rate limiting
  MAX_BROADCAST_QUEUE: 200, // ✅ BARU: Batas queue
  CONNECTION_TIMEOUT_MS: 5000, // ✅ BARU: Timeout 5 detik
};

const ROOMS = [
  "LowCard 1", "LowCard 2", "Gacor", "General", "Pakistan", "Philippines",
  "India", "LOVE BIRDS", "Birthday Party", "Heart Lovers", "Cat lovers",
  "Chikahan Tambayan", "Happy Vibes", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES", "Relax & Chat", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

// ✅ BARU: Rate limiter per user
class RateLimiter {
  constructor() {
    this.userMessages = new Map();
    this.windowMs = 60000;
    this.maxMessages = C.MAX_MESSAGES_PER_MINUTE;
  }

  checkLimit(username) {
    if (!username) return true;
    
    const now = Date.now();
    const record = this.userMessages.get(username);
    
    if (!record || now > record.resetTime) {
      this.userMessages.set(username, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return true;
    }
    
    if (record.count >= this.maxMessages) {
      return false;
    }
    
    record.count++;
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [username, record] of this.userMessages) {
      if (now > record.resetTime) {
        this.userMessages.delete(username);
      }
    }
  }
}

class RoomManager {
  constructor(name) {
    this.name = name;
    this.seats = new Map();
    this.points = new Map();
    this.muted = false;
    this.number = 1;
  }

  getAvailableSeat() {
    for (let seat = 1; seat <= C.MAX_SEATS; seat++) {
      if (!this.seats.has(seat)) return seat;
    }
    return null;
  }

  addSeat(userId, noimageUrl, color, itembawah, itematas, vip, viptanda) {
    if (!userId) return null;
    
    for (const [seat, data] of this.seats) {
      if (data && data.namauser === userId) return seat;
    }
    
    const seat = this.getAvailableSeat();
    if (!seat) return null;
    
    this.seats.set(seat, {
      noimageUrl: noimageUrl || "",
      namauser: userId,
      color: color || "",
      itembawah: itembawah || 0,
      itematas: itematas || 0,
      vip: vip || 0,
      viptanda: viptanda || 0,
    });
    return seat;
  }

  updateSeat(seat, data) {
    if (!this.seats.has(seat) || !data) return false;
    const old = this.seats.get(seat);
    if (!old) return false;
    
    this.seats.set(seat, {
      noimageUrl: data.noimageUrl !== undefined ? data.noimageUrl : old.noimageUrl,
      namauser: data.namauser !== undefined ? data.namauser : old.namauser,
      color: data.color !== undefined ? data.color : old.color,
      itembawah: data.itembawah !== undefined ? data.itembawah : old.itembawah,
      itematas: data.itematas !== undefined ? data.itematas : old.itematas,
      vip: data.vip !== undefined ? data.vip : old.vip,
      viptanda: data.viptanda !== undefined ? data.viptanda : old.viptanda,
    });
    return true;
  }

  removeSeat(seat) {
    this.points.delete(seat);
    return this.seats.delete(seat);
  }
  
  getSeat(seat) { 
    const data = this.seats.get(seat);
    return data ? { ...data } : null;
  }
  
  getCount() { return this.seats.size; }
  
  getAllSeats() {
    const result = {};
    for (const [seat, data] of this.seats) {
      if (data) result[seat] = { ...data };
    }
    return result;
  }

  setMuted(val) { 
    this.muted = !!val; 
    return this.muted; 
  }
  
  getMuted() { return this.muted; }
  
  setNumber(n) { 
    this.number = n || 1; 
  }
  getNumber() { return this.number; }

  updatePoint(seat, x, y, fast) {
    if (!this.seats.has(seat)) return false;
    this.points.set(seat, { x: x || 0, y: y || 0, fast: !!fast });
    return true;
  }

  getPoint(seat) { 
    const point = this.points.get(seat);
    return point ? { ...point } : null;
  }
  
  getAllPoints() {
    const result = [];
    for (const [seat, point] of this.points) {
      if (this.seats.has(seat) && point) {
        result.push({ seat, x: point.x, y: point.y, fast: point.fast ? 1 : 0 });
      }
    }
    return result;
  }
}

export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.closing = false;
    this.isDestroyed = false;
    
    // ✅ BARU: Rate limiter
    this.rateLimiter = new RateLimiter();
    
    // ✅ PERBAIKAN: WeakMap → Map (mencegah memory leak)
    this.wsSet = new Set();
    this.userConnections = new Map();
    this.userSeat = new Map();
    this.userRoom = new Map();
    this.userCountry = new Map();
    this.roomClients = new Map();
    this.rooms = new Map();
    this.wsActiveMulti = new Map();
    this.wsToUsername = new Map(); // ✅ PERBAIKAN: Map bukan WeakMap
    this.wsToRoom = new Map();     // ✅ PERBAIKAN: Map bukan WeakMap
    
    this._processingMessages = new Set();
    this._cleaningUp = new Set();
    this._pendingTimeouts = new Set();
    this._isCleaningUp = false;
    this._cleanupInProgress = false;
    this._errorCount = 0;
    
    this.currentNumber = 1;
    this._lastNumberChange = Date.now();
    
    this._broadcastQueue = new Map();
    this._broadcastTimer = null;
    this._batchSize = C.BROADCAST_BATCH_SIZE;
    
    this._mainInterval = null;
    this._cleanupInterval = null;
    this._lastActivityTime = Date.now();
    this._lastCleanupTime = Date.now();
    
    for (const room of ROOMS) {
      this.rooms.set(room, new RoomManager(room));
      this.roomClients.set(room, new Set());
    }
    
    this._startIntervals();
  }
  
  _startIntervals() {
    // ✅ DIUBAH: 30 menit
    if (this._mainInterval) {
      clearInterval(this._mainInterval);
    }
    this._mainInterval = setInterval(() => {
      if (!this.closing && !this.isDestroyed) {
        try {
          this._doMainTask();
        } catch(e) {
          this._errorCount++;
        }
      }
    }, C.INTERVAL_30_MENIT);
    
    // ✅ BARU: Cleanup interval 60 detik
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    this._cleanupInterval = setInterval(() => {
      if (!this.closing && !this.isDestroyed) {
        try {
          this._cleanupDeadConnections();
        } catch(e) {
          this._errorCount++;
        }
      }
    }, C.CLEANUP_INTERVAL);
    
    // ✅ BARU: Rate limiter cleanup
    setInterval(() => {
      try {
        this.rateLimiter.cleanup();
      } catch(e) {}
    }, 60000);
  }
  
  _doMainTask() {
    try {
      this._lastActivityTime = Date.now();
      
      // ✅ HANYA kirim jika ada client
      let hasActiveRoom = false;
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          hasActiveRoom = true;
          break;
        }
      }
      if (!hasActiveRoom) return;
      
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
      
      // ✅ KIRIM ke room yang aktif saja
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          try {
            this._broadcastToRoom(room, numberMsg).catch(() => {});
          } catch(e) {
            this._errorCount++;
          }
        }
      }
      
      // ✅ Cleanup room manager
      for (const [room, roomMan] of this.rooms) {
        if (roomMan) {
          try {
            roomMan.cleanup();
          } catch(e) {
            this._errorCount++;
          }
        }
      }
      
    } catch(e) {
      this._errorCount++;
    }
  }
  
  // ✅ BARU: Cleanup koneksi mati
  _cleanupDeadConnections() {
    try {
      // ✅ AMBIL SNAPSHOT sebelum modifikasi
      const wsToRemove = [];
      for (const ws of this.wsSet) {
        try {
          if (!ws || ws.readyState !== 1 || ws._closing) {
            wsToRemove.push(ws);
          }
        } catch(e) {
          wsToRemove.push(ws);
        }
      }
      
      for (const ws of wsToRemove) {
        try {
          this.cleanup(ws).catch(() => {});
        } catch(e) {}
      }
      
      // ✅ Bersihkan room clients
      for (const [room, clients] of this.roomClients) {
        if (clients) {
          const validClients = new Set();
          for (const ws of clients) {
            try {
              if (ws && ws.readyState === 1 && !ws._closing) {
                const username = this.wsToUsername.get(ws);
                if (username) {
                  const conns = this.userConnections.get(username);
                  if (conns && conns.has(ws)) {
                    validClients.add(ws);
                  }
                }
              }
            } catch(e) {}
          }
          this.roomClients.set(room, validClients);
        }
      }
      
      // ✅ Bersihkan queue jika terlalu besar
      if (this._broadcastQueue.size > C.MAX_BROADCAST_QUEUE) {
        this._broadcastQueue.clear();
        if (this._broadcastTimer) {
          clearTimeout(this._broadcastTimer);
          this._broadcastTimer = null;
        }
      }
      
      // ✅ Rate limiter cleanup
      this.rateLimiter.cleanup();
      
      this._lastCleanupTime = Date.now();
      
    } catch(e) {
      this._errorCount++;
    }
  }
  
  async _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed) return 0;
    const clients = this.roomClients.get(room);
    if (!clients?.size) return 0;
    
    const clientArray = Array.from(clients);
    let count = 0;
    const toRemove = [];
    
    for (let i = 0; i < clientArray.length; i++) {
      const ws = clientArray[i];
      if (!ws) continue;
      
      try {
        if (ws.readyState === 1 && !ws._closing && !this._cleaningUp.has(ws)) {
          ws.send(msgStr);
          count++;
        } else {
          toRemove.push(ws);
        }
      } catch(e) {
        toRemove.push(ws);
      }
    }
    
    if (toRemove.length > 0) {
      for (const ws of toRemove) {
        try {
          if (clients) clients.delete(ws);
          await this.cleanup(ws);
        } catch(e) {}
      }
    }
    
    return count;
  }
  
  _queueBroadcast(room, msg) {
    if (this.closing || this.isDestroyed) return;
    
    // ✅ Cek queue size
    if (this._broadcastQueue.size > C.MAX_BROADCAST_QUEUE) {
      this._broadcastQueue.clear();
      if (this._broadcastTimer) {
        clearTimeout(this._broadcastTimer);
        this._broadcastTimer = null;
      }
      return;
    }
    
    try {
      const key = `${room}`;
      if (!this._broadcastQueue.has(key)) {
        this._broadcastQueue.set(key, []);
      }
      const queue = this._broadcastQueue.get(key);
      if (queue && queue.length < 50) {
        queue.push(msg);
      }
      
      if (!this._broadcastTimer) {
        this._broadcastTimer = setTimeout(() => {
          try {
            this._flushBroadcastQueue();
          } catch(e) {
            this._errorCount++;
          }
        }, 50); // ✅ DIUBAH: 10ms → 50ms
      }
    } catch(e) {
      this._errorCount++;
    }
  }
  
  _flushBroadcastQueue() {
    this._broadcastTimer = null;
    
    if (this._broadcastQueue.size === 0) return;
    
    try {
      let processed = 0;
      const maxPerFlush = 100;
      
      for (const [room, messages] of this._broadcastQueue) {
        if (!messages || messages.length === 0) continue;
        
        const toSend = messages.splice(0, Math.min(messages.length, 20));
        processed += toSend.length;
        
        for (const msg of toSend) {
          if (msg) {
            try {
              this._broadcastToRoom(room, JSON.stringify(msg)).catch(() => {});
            } catch(e) {
              this._errorCount++;
            }
          }
        }
        
        if (messages.length === 0) {
          this._broadcastQueue.delete(room);
        }
        
        if (processed >= maxPerFlush) {
          if (!this._broadcastTimer) {
            this._broadcastTimer = setTimeout(() => {
              try {
                this._flushBroadcastQueue();
              } catch(e) {
                this._errorCount++;
              }
            }, 100);
          }
          return;
        }
      }
    } catch(e) {
      this._errorCount++;
    } finally {
      if (this._broadcastQueue.size === 0) {
        this._broadcastQueue.clear();
      }
    }
  }
  
  async broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try {
      this._queueBroadcast(room, msg);
    } catch(e) {
      this._errorCount++;
    }
  }
  
  safeSend(ws, msg) {
    if (!ws || ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
      return false;
    }
    
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch(e) {
      this.cleanup(ws).catch(() => {});
      return false;
    }
  }
  
  updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    try {
      const roomMan = this.rooms.get(room);
      if (!roomMan) return 0;
      const count = roomMan.getCount();
      if (count > 0) {
        this.broadcast(room, ["roomUserCount", room, count]);
      }
      return count;
    } catch(e) {
      return 0;
    }
  }
  
  sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username || ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
      return;
    }
    
    const roomMan = this.rooms.get(room);
    if (!roomMan) return;
    
    try {
      const allSeats = roomMan.getAllSeats();
      const allPoints = roomMan.getAllPoints();
      const selfSeat = this.userSeat.get(ws.username)?.seat;
      
      if (roomMan.getCount() > 0) {
        this.safeSend(ws, ["roomUserCount", room, roomMan.getCount()]);
      }
      
      if (allSeats && Object.keys(allSeats).length > 0) {
        if (excludeSelf && selfSeat && allSeats[selfSeat]) {
          const filtered = { ...allSeats };
          delete filtered[selfSeat];
          if (Object.keys(filtered).length > 0) {
            this.safeSend(ws, ["allUpdateKursiList", room, filtered]);
          }
        } else {
          this.safeSend(ws, ["allUpdateKursiList", room, allSeats]);
        }
      }
      
      if (allPoints?.length > 0) {
        let filteredPoints = allPoints;
        if (excludeSelf && selfSeat) {
          filteredPoints = allPoints.filter(p => p.seat !== selfSeat);
        }
        if (filteredPoints.length > 0) {
          this.safeSend(ws, ["allPointsList", room, filteredPoints]);
        }
      }
    } catch(e) {
      this._errorCount++;
    }
  }
  
  async cleanup(ws) {
    if (!ws || ws._cleaning || this._cleaningUp.has(ws) || this._isCleaningUp) {
      return;
    }
    
    ws._cleaning = true;
    this._cleaningUp.add(ws);
    this._isCleaningUp = true;
    
    try {
      const username = ws.username;
      const room = ws.room;
      
      if (room) {
        const clients = this.roomClients.get(room);
        if (clients) clients.delete(ws);
      }
      
      const activeData = this.wsActiveMulti.get(ws);
      if (activeData?.room) {
        const clients = this.roomClients.get(activeData.room);
        if (clients) clients.delete(ws);
      }
      this.wsActiveMulti.delete(ws);
      
      // ✅ PERBAIKAN: Hapus dari wsToUsername dan wsToRoom
      this.wsToUsername.delete(ws);
      this.wsToRoom.delete(ws);
      
      if (username) {
        const connections = this.userConnections.get(username);
        if (connections) {
          connections.delete(ws);
          
          const seatInfo = this.userSeat.get(username);
          const isMulti = seatInfo?.isMulti === true;
          
          if (!isMulti && connections.size === 0) {
            this.userConnections.delete(username);
            this.userCountry.delete(username);
            
            if (seatInfo?.room) {
              const roomMan = this.rooms.get(seatInfo.room);
              if (roomMan) {
                const seatData = roomMan.getSeat(seatInfo.seat);
                if (seatData?.namauser === username) {
                  roomMan.removeSeat(seatInfo.seat);
                  await this.broadcast(seatInfo.room, ["removeKursi", seatInfo.room, seatInfo.seat]);
                  this.updateRoomCount(seatInfo.room);
                }
              }
            }
            
            this.userSeat.delete(username);
            this.userRoom.delete(username);
          }
        }
      }
      
      this.wsSet.delete(ws);
      
    } catch(e) {
      this._errorCount++;
    } finally {
      ws._cleaning = false;
      this._cleaningUp.delete(ws);
      this._isCleaningUp = false;
      
      try {
        if (ws && ws.readyState === 1) {
          ws.close(1000, "Cleanup");
        }
      } catch(e) {}
    }
  }
  
  async handleMessage(ws, raw) {
    // ✅ CEK AWAL
    if (!ws || ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
      return;
    }
    
    if (this._processingMessages.has(ws)) return;
    this._processingMessages.add(ws);
    
    // ✅ TIMEOUT protection
    const timeoutId = setTimeout(() => {
      try {
        if (ws && ws.readyState === 1) {
          this.safeSend(ws, ["error", "Processing timeout"]);
        }
      } catch(e) {}
    }, C.CONNECTION_TIMEOUT_MS);
    
    try {
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) {
        this.safeSend(ws, ["error", "Message too long"]);
        return;
      }
      
      let data;
      try { data = JSON.parse(str); } catch(e) {
        this.safeSend(ws, ["error", "Invalid JSON"]);
        return;
      }
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      
      // ✅ RATE LIMITING
      if (evt === "chat" || evt === "updatePoint" || evt === "gift" || evt === "rollangak") {
        const username = ws.username;
        if (username && !this.rateLimiter.checkLimit(username)) {
          this.safeSend(ws, ["error", "Rate limit exceeded, please wait"]);
          return;
        }
      }
      
      if (evt === "chat" || evt === "updatePoint" || evt === "gift" || evt === "rollangak") {
        const room = args[0];
        if (room && !ROOMS_SET.has(room)) {
          this.safeSend(ws, ["error", "Invalid room"]);
          return;
        }
      }
      
      // ✅ PROCESS EVENT dengan try-catch per case
      try {
        switch(evt) {
          case "setIdTarget2":
            await this.handleSetId(ws, args[0], args[1]);
            break;
          
          case "joinRoom":
            await this.handleJoin(ws, args[0]);
            break;
          
          case "multiJoin": {
            const multiUsername = args[0];
            const multiRoomname = args[1];
            if (!multiUsername || !multiRoomname || this.closing || this.isDestroyed) break;
            
            let existingSeat = null, existingRoom = null;
            for (const [roomName, roomMan] of this.rooms) {
              if (!roomMan) continue;
              for (const [seat, seatData] of roomMan.seats) {
                if (seatData?.namauser === multiUsername) {
                  existingSeat = seat;
                  existingRoom = roomName;
                  break;
                }
              }
              if (existingSeat) break;
            }
            
            if (existingSeat && existingRoom) {
              try {
                const oldRoomMan = this.rooms.get(existingRoom);
                if (oldRoomMan) {
                  oldRoomMan.removeSeat(existingSeat);
                  await this.broadcast(existingRoom, ["removeKursi", existingRoom, existingSeat]);
                  this.updateRoomCount(existingRoom);
                }
              } catch(e) {}
              this.userSeat.delete(multiUsername);
              this.userRoom.delete(multiUsername);
            }
            
            const roomMan = this.rooms.get(multiRoomname);
            if (!roomMan || roomMan.getCount() >= C.MAX_SEATS) break;
            
            const seat = roomMan.addSeat(multiUsername, "", "", 0, 0, 0, 0);
            if (!seat) break;
            
            this.userSeat.set(multiUsername, { room: multiRoomname, seat, isMulti: true });
            this.userRoom.set(multiUsername, multiRoomname);
            if (!this.userCountry.has(multiUsername)) {
              this.userCountry.set(multiUsername, ws.clientCountry || "Unknown");
            }
            
            this.wsToUsername.set(ws, multiUsername);
            this.wsToRoom.set(ws, multiRoomname);
            
            let connections = this.userConnections.get(multiUsername);
            if (!connections) connections = new Set();
            if (!connections.has(ws)) connections.add(ws);
            this.userConnections.set(multiUsername, connections);
            
            this.wsActiveMulti.set(ws, { username: multiUsername, room: multiRoomname });
            const roomClients = this.roomClients.get(multiRoomname);
            if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
            
            this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
            try {
              await this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, roomMan.getCount()]);
            } catch(e) {}
            break;
          }
          
          case "exitMulti": {
            const targetUsername = args[0];
            if (!targetUsername) break;
            
            const seatInfo = this.userSeat.get(targetUsername);
            if (!seatInfo) break;
            
            const roomName = seatInfo.room;
            const seatNumber = seatInfo.seat;
            
            const activeData = this.wsActiveMulti.get(ws);
            if (activeData?.username === targetUsername) {
              const roomClients = this.roomClients.get(roomName);
              if (roomClients) roomClients.delete(ws);
              this.wsActiveMulti.delete(ws);
            }
            
            try {
              const roomMan = this.rooms.get(roomName);
              if (roomMan) {
                roomMan.removeSeat(seatNumber);
                await this.broadcast(roomName, ["removeKursi", roomName, seatNumber]);
                await this.broadcast(roomName, ["roomUserCount", roomName, roomMan.getCount()]);
              }
            } catch(e) {}
            
            this.userSeat.delete(targetUsername);
            this.userRoom.delete(targetUsername);
            
            try {
              const connections = this.userConnections.get(targetUsername);
              if (connections) {
                connections.delete(ws);
                if (connections.size === 0) {
                  this.userConnections.delete(targetUsername);
                  this.userCountry.delete(targetUsername);
                }
              }
            } catch(e) {}
            
            this.wsToUsername.delete(ws);
            this.wsToRoom.delete(ws);
            
            if (ws.username === targetUsername) {
              ws.username = null;
              ws.idtarget = null;
            }
            
            break;
          }
          
          case "setActiveMulti": {
            const targetUsername = args[0];
            const seatInfo = this.userSeat.get(targetUsername);
            if (!seatInfo) break;
            
            const roomName = seatInfo.room;
            const seatNumber = seatInfo.seat;
            
            const oldActive = this.wsActiveMulti.get(ws);
            if (oldActive?.room) {
              const oldClients = this.roomClients.get(oldActive.room);
              if (oldClients) oldClients.delete(ws);
            }
            
            this.wsActiveMulti.set(ws, { username: targetUsername, room: roomName });
            this.wsToUsername.set(ws, targetUsername);
            this.wsToRoom.set(ws, roomName);
            
            const roomClients = this.roomClients.get(roomName);
            if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
            
            ws.username = targetUsername;
            ws.idtarget = targetUsername;
            ws.room = roomName;
            ws.roomname = roomName;
            
            this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
            try {
              if (roomName) await this.broadcast(roomName, ["userActiveChanged", targetUsername, seatNumber]);
            } catch(e) {}
            break;
          }
          
          case "updateKursi": {
            const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt] = args;
            const roomMan = this.rooms.get(kursiRoom);
            if (!roomMan) break;
            
            const updated = roomMan.updateSeat(kursiSeat, {
              noimageUrl: kursiNoimg, namauser: kursiName, color: kursiColor,
              itembawah: kursiBawah, itematas: kursiAtas, vip: kursiVip, viptanda: kursiVt
            });
            
            if (updated) {
              const updatedSeat = roomMan.getSeat(kursiSeat);
              try {
                await this.broadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, updatedSeat]]]);
              } catch(e) {}
            }
            break;
          }
          
          case "chat": {
            const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
            if (chatMsg && ROOMS_SET.has(chatRoom)) {
              // ✅ Batasi panjang pesan
              let finalMsg = chatMsg;
              if (finalMsg.length > 500) {
                finalMsg = finalMsg.substring(0, 500) + "...";
              }
              
              // ✅ Cek room ada client
              const clients = this.roomClients.get(chatRoom);
              if (!clients || clients.size === 0) break;
              
              try {
                const msgStr = JSON.stringify(["chat", chatRoom, chatNoimg, chatUser, finalMsg, chatColor, chatTextColor]);
                this._broadcastToRoom(chatRoom, msgStr);
              } catch(e) {
                this._errorCount++;
              }
            }
            break;
          }
          
          case "updatePoint": {
            const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
            if (pointRoom && typeof pointSeat === 'number' && pointSeat >= 1 && pointSeat <= C.MAX_SEATS) {
              const roomMan = this.rooms.get(pointRoom);
              if (roomMan && roomMan.seats.has(pointSeat)) {
                if (roomMan.updatePoint(pointSeat, pointX, pointY, pointFast === 1)) {
                  try {
                    const msgStr = JSON.stringify(["pointUpdated", pointRoom, pointSeat, pointX, pointY, pointFast]);
                    this._broadcastToRoom(pointRoom, msgStr);
                  } catch(e) {
                    this._errorCount++;
                  }
                }
              }
            }
            break;
          }
          
          case "removeKursiAndPoint": {
            const [removeRoom, removeSeat] = args;
            const roomMan = this.rooms.get(removeRoom);
            if (roomMan && roomMan.seats.has(removeSeat)) {
              for (const [username, info] of this.userSeat) {
                if (info.seat === removeSeat && info.room === removeRoom) {
                  this.userSeat.delete(username);
                  this.userRoom.delete(username);
                  break;
                }
              }
              roomMan.removeSeat(removeSeat);
              try {
                await this.broadcast(removeRoom, ["removeKursi", removeRoom, removeSeat]);
                this.updateRoomCount(removeRoom);
              } catch(e) {}
            }
            break;
          }
          
          case "private": {
            const [privTarget, privNoimg, privMsg, privSender] = args;
            if (privTarget && privMsg) {
              // ✅ Batasi panjang pesan private
              let finalMsg = privMsg;
              if (finalMsg.length > 500) {
                finalMsg = finalMsg.substring(0, 500) + "...";
              }
              
              const targetConns = this.userConnections.get(privTarget);
              if (targetConns) {
                for (const targetWs of targetConns) {
                  if (targetWs?.readyState === 1) {
                    this.safeSend(targetWs, ["private", privTarget, privNoimg, finalMsg, Date.now(), privSender]);
                    break;
                  }
                }
              }
              this.safeSend(ws, ["private", privTarget, privNoimg, finalMsg, Date.now(), privSender]);
            }
            break;
          }
          
          case "gift": {
            const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
            if (giftRoom && ROOMS_SET.has(giftRoom)) {
              const clients = this.roomClients.get(giftRoom);
              if (!clients || clients.size === 0) break;
              
              try {
                const msgStr = JSON.stringify(["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]);
                this._broadcastToRoom(giftRoom, msgStr);
              } catch(e) {
                this._errorCount++;
              }
            }
            break;
          }
          
          case "rollangak": {
            const [rollRoom, rollUser, rollAngka] = args;
            if (rollRoom && ROOMS_SET.has(rollRoom)) {
              const clients = this.roomClients.get(rollRoom);
              if (!clients || clients.size === 0) break;
              
              try {
                const msgStr = JSON.stringify(["rollangakBroadcast", rollRoom, rollUser, rollAngka]);
                this._broadcastToRoom(rollRoom, msgStr);
              } catch(e) {
                this._errorCount++;
              }
            }
            break;
          }
          
          case "sendnotif": {
            const [notifTarget, notifNoimg, notifUser, notifMsg] = args;
            if (notifTarget && notifMsg) {
              const targetConns = this.userConnections.get(notifTarget);
              if (targetConns) {
                for (const c of targetConns) {
                  if (c?.readyState === 1) {
                    this.safeSend(c, ["notif", notifNoimg, notifUser, notifMsg, Date.now()]);
                    break;
                  }
                }
              }
            }
            break;
          }
          
          case "getCurrentNumber":
            this.safeSend(ws, ["currentNumber", this.currentNumber]);
            break;
          
          case "isUserOnline": {
            const [onlineTarget, onlineCallback] = args;
            let isOnline = false;
            const seatInfo = this.userSeat.get(onlineTarget);
            if (seatInfo?.seat) {
              if (seatInfo.isMulti) {
                isOnline = true;
              } else {
                const connections = this.userConnections.get(onlineTarget);
                if (connections) {
                  for (const conn of connections) {
                    if (conn?.readyState === 1) { isOnline = true; break; }
                  }
                }
              }
            }
            this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
            break;
          }
          
          case "getOnlineUsers": {
            const users = [];
            for (const [username, seatInfo] of this.userSeat) {
              if (seatInfo?.seat) {
                if (seatInfo.isMulti) {
                  users.push(username);
                } else {
                  const connections = this.userConnections.get(username);
                  if (connections) {
                    for (const conn of connections) {
                      if (conn?.readyState === 1) { users.push(username); break; }
                    }
                  }
                }
              }
            }
            this.safeSend(ws, ["allOnlineUsers", users]);
            break;
          }
          
          case "getAllRoomsUserCount": {
            const counts = {};
            for (const room of ROOMS) {
              const rm = this.rooms.get(room);
              counts[room] = rm?.getCount() || 0;
            }
            this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
            break;
          }
          
          case "getRoomUserCount": {
            const roomName = args[0];
            if (roomName && ROOMS_SET.has(roomName)) {
              const rm = this.rooms.get(roomName);
              this.safeSend(ws, ["roomUserCount", roomName, rm?.getCount() || 0]);
            }
            break;
          }
          
          case "setMuteType": {
            const [muteVal, muteRoom] = args;
            if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
            
            const rm = this.rooms.get(muteRoom);
            if (!rm) break;
            
            rm.setMuted(muteVal);
            try {
              await this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
            } catch(e) {}
            this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
            break;
          }

          case "modwarning": {
            const modRoom = args[0];
            if (modRoom && ROOMS_SET.has(modRoom)) {
              try {
                await this.broadcast(modRoom, ["modwarning", modRoom]);
              } catch(e) {}
            }
            break;
          }

          case "getMuteType": {
            const getMuteRoom = args[0];
            if (getMuteRoom && ROOMS_SET.has(getMuteRoom)) {
              const rm = this.rooms.get(getMuteRoom);
              this.safeSend(ws, ["muteTypeResponse", rm?.getMuted() || false, getMuteRoom]);
            }
            break;
          }
          
          case "onDestroy":
            await this.cleanup(ws);
            break;
          
          default:
            this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
            break;
        }
      } catch(e) {
        // ✅ TANGKAP ERROR per case
        this._errorCount++;
        this.safeSend(ws, ["error", "Processing error: " + (e.message || "Unknown")]);
      }
      
    } catch(e) {
      // ✅ TANGKAP ERROR global
      this._errorCount++;
      try {
        this.safeSend(ws, ["error", "Error: " + (e.message || "Unknown")]);
      } catch(err) {}
    } finally {
      clearTimeout(timeoutId);
      this._processingMessages.delete(ws);
    }
  }
  
  async handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { 
        if (ws?.readyState === 1) ws.close(1000, "Invalid username"); 
      } catch(e) {}
      return;
    }
    
    const userCountry = ws.clientCountry || "Unknown";
    
    const existingSeatInfo = this.userSeat.get(username);
    const isMultiUser = existingSeatInfo?.isMulti === true;
    
    if (isMultiUser && isNewUser === false) {
      this.wsToUsername.set(ws, username);
      this.wsToRoom.set(ws, existingSeatInfo.room);
      
      ws.username = username;
      ws.idtarget = username;
      ws.room = existingSeatInfo.room;
      ws.roomname = existingSeatInfo.room;
      
      if (!this.userCountry.has(username)) {
        this.userCountry.set(username, userCountry);
      }
      
      let connections = this.userConnections.get(username);
      if (!connections) connections = new Set();
      if (!connections.has(ws)) connections.add(ws);
      this.userConnections.set(username, connections);
      
      if (!this.wsSet.has(ws)) this.wsSet.add(ws);
      
      const roomClients = this.roomClients.get(existingSeatInfo.room);
      if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
      
      const roomMan = this.rooms.get(existingSeatInfo.room);
      if (roomMan && !this.isDestroyed) {
        try {
          const seatData = roomMan.getSeat(existingSeatInfo.seat);
          const pointData = roomMan.getPoint(existingSeatInfo.seat);
          
          this.safeSend(ws, ["numberKursiSaya", existingSeatInfo.seat]);
          if (seatData) this.safeSend(ws, ["kursiData", existingSeatInfo.room, existingSeatInfo.seat, seatData]);
          if (pointData) this.safeSend(ws, ["pointData", existingSeatInfo.room, existingSeatInfo.seat, pointData.x, pointData.y, pointData.fast ? 1 : 0]);
          this.safeSend(ws, ["muteTypeResponse", roomMan.getMuted(), existingSeatInfo.room]);
          this.safeSend(ws, ["roomUserCount", existingSeatInfo.room, roomMan.getCount()]);
          
          setTimeout(() => {
            if (ws && ws.readyState === 1 && !this.closing && !this.isDestroyed) {
              this.sendAllStateTo(ws, existingSeatInfo.room, true);
            }
          }, 300);
        } catch(e) {
          this._errorCount++;
        }
      }
      return;
    }
    
    // Cek user sudah ada
    const existingConns = this.userConnections.get(username);
    if (existingConns?.size > 0) {
      for (const oldWs of Array.from(existingConns)) {
        if (oldWs && oldWs !== ws && oldWs.readyState === 1) {
          await this.cleanup(oldWs);
        }
      }
    }
    
    this.wsToUsername.set(ws, username);
    ws.username = username;
    ws.idtarget = username;
    if (!this.userCountry.has(username)) {
      this.userCountry.set(username, userCountry);
    }
    
    let connections = this.userConnections.get(username);
    if (!connections) connections = new Set();
    if (!connections.has(ws)) connections.add(ws);
    this.userConnections.set(username, connections);
    
    if (!this.wsSet.has(ws)) this.wsSet.add(ws);
    
    this.safeSend(ws, isNewUser ? ["joinroomawal"] : ["needJoinRoom"]);
  }
  
  async handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    const oldRoom = ws.room;
    
    if (oldRoom && oldRoom !== roomName) {
      try {
        const oldMan = this.rooms.get(oldRoom);
        if (oldMan) {
          const oldSeat = this.userSeat.get(username)?.seat;
          if (oldSeat) {
            oldMan.removeSeat(oldSeat);
            await this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
            this.updateRoomCount(oldRoom);
          }
        }
        const oldClients = this.roomClients.get(oldRoom);
        if (oldClients) oldClients.delete(ws);
        this.userSeat.delete(username);
        this.userRoom.delete(username);
      } catch(e) {}
      ws.room = null;
      ws.roomname = null;
    }
    
    const roomMan = this.rooms.get(roomName);
    if (!roomMan) return false;
    
    let seat = null;
    for (const [s, data] of roomMan.seats) {
      if (data?.namauser === username) { seat = s; break; }
    }
    
    if (!seat) {
      if (roomMan.getCount() >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      seat = roomMan.getAvailableSeat();
      if (!seat) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      roomMan.addSeat(username, "", "", 0, 0, 0, 0);
    }
    
    this.userSeat.set(username, { room: roomName, seat, isMulti: false });
    this.userRoom.set(username, roomName);
    this.wsToRoom.set(ws, roomName);
    ws.room = roomName;
    ws.roomname = roomName;
    ws.idtarget = username;
    
    const roomClients = this.roomClients.get(roomName);
    if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
    
    const seatData = roomMan.getSeat(seat);
    const pointData = roomMan.getPoint(seat);
    
    this.safeSend(ws, ["rooMasuk", seat, roomName]);
    this.safeSend(ws, ["numberKursiSaya", seat]);
    this.safeSend(ws, ["muteTypeResponse", roomMan.getMuted(), roomName]);
    this.safeSend(ws, ["roomUserCount", roomName, roomMan.getCount()]);
    
    if (seatData) {
      this.safeSend(ws, ["kursiData", roomName, seat, seatData]);
    }
    if (pointData) {
      this.safeSend(ws, ["pointData", roomName, seat, pointData.x, pointData.y, pointData.fast ? 1 : 0]);
    }
    
    this.updateRoomCount(roomName);
    
    setTimeout(() => {
      try {
        if (ws && ws.readyState === 1 && !this.closing && !this.isDestroyed) {
          this.sendAllStateTo(ws, roomName, true);
        }
      } catch(e) {}
    }, 1000);
    
    return true;
  }
  
  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    try {
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server", { 
          status: 200,
          headers: {
            "Cache-Control": "no-cache"
          }
        });
      }
      
      if (this.wsSet.size >= C.MAX_GLOBAL_CONNECTIONS) {
        return new Response("Server full", { status: 503 });
      }
      
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const clientCountry = this._getClientCountry(req);
      
      try { 
        this.state.acceptWebSocket(server); 
      } catch(e) { 
        return new Response("WebSocket acceptance failed", { status: 500 }); 
      }
      
      server.username = null;
      server.room = null;
      server.roomname = null;
      server.idtarget = null;
      server._closing = false;
      server.clientCountry = clientCountry;
      server._wsId = Date.now() + Math.random();
      
      if (!this.wsSet.has(server)) {
        this.wsSet.add(server);
      }
      
      return new Response(null, { status: 101, webSocket: client });
      
    } catch(e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }
  
  async webSocketMessage(ws, msg) { 
    if (!ws || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) return;
    try {
      await this.handleMessage(ws, msg);
    } catch(e) {
      this._errorCount++;
    }
  }
  
  async webSocketClose(ws) { 
    if (!ws) return;
    try {
      await this.cleanup(ws);
    } catch(e) {
      this._errorCount++;
    }
  }
  
  async webSocketError(ws) { 
    if (!ws) return;
    try {
      await this.cleanup(ws);
    } catch(e) {
      this._errorCount++;
    }
  }
  
  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    if (this._mainInterval) {
      clearInterval(this._mainInterval);
      this._mainInterval = null;
    }
    
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    
    if (this._broadcastTimer) {
      clearTimeout(this._broadcastTimer);
      this._broadcastTimer = null;
    }
    
    for (const timeout of this._pendingTimeouts) {
      clearTimeout(timeout);
    }
    this._pendingTimeouts.clear();
    
    const wsCopy = Array.from(this.wsSet);
    for (const ws of wsCopy) {
      if (ws?.readyState === 1) {
        try { 
          ws.send(JSON.stringify(["serverShutdown", "Server shutting down"])); 
        } catch(e) {}
        try { 
          ws.close(1000, "Shutdown"); 
        } catch(e) {}
      }
      try {
        await this.cleanup(ws);
      } catch(e) {}
    }
    
    this.wsSet.clear();
    this.userConnections.clear();
    this.userSeat.clear();
    this.userRoom.clear();
    this.userCountry.clear();
    this.wsActiveMulti.clear();
    this.wsToUsername.clear();
    this.wsToRoom.clear();
    this.roomClients.clear();
    this.rooms.clear();
    this._processingMessages.clear();
    this._cleaningUp.clear();
    this._broadcastQueue.clear();
    this._errorCount = 0;
  }
  
  _getClientCountry(req) {
    try {
      const country = req.headers.get("CF-IPCountry") || 
                      req.headers.get("X-Country-Code") ||
                      "Unknown";
      return country;
    } catch(e) { 
      return "Unknown"; 
    }
  }
  
  getStats() {
    return {
      connections: this.wsSet.size,
      messagesProcessed: this._broadcastQueue.size,
      errors: this._errorCount,
      userConnections: this.userConnections.size,
      userSeats: this.userSeat.size,
      userRooms: this.userRoom.size,
      roomClients: Array.from(this.roomClients.entries()).map(([room, clients]) => ({
        room,
        count: clients.size
      })),
      broadcastQueueSize: this._broadcastQueue.size,
      pendingTimeouts: this._pendingTimeouts.size,
      lastCleanup: new Date(this._lastCleanupTime).toISOString(),
      lastActivity: new Date(this._lastActivityTime).toISOString()
    };
  }
}
