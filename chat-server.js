// ==================== CHAT SERVER - DENGAN D1 DATABASE ====================

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 500,
  MAX_MESSAGE_SIZE: 5000,
  ALARM_10_DETIK: 10000,
  NUMBER_UPDATE_TIK: 90,
  MAX_NUMBER: 6,
  BATCH_SIZE: 20,
  LOCK_TIMEOUT: 10000,
  CLEANUP_INTERVAL: 30000,
  MAX_ROOM_CLIENTS: 500,
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

// ==================== DATABASE HELPER ====================
class DatabaseHelper {
  constructor(db) {
    this.db = db;
  }

  async initTables() {
    try {
      // Tabel rooms
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          room_name TEXT PRIMARY KEY,
          muted INTEGER DEFAULT 0,
          number INTEGER DEFAULT 1,
          last_activity INTEGER DEFAULT 0
        )
      `);

      // Tabel seats
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS seats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_name TEXT,
          seat_number INTEGER,
          user_id TEXT,
          noimage_url TEXT,
          color TEXT,
          itembawah INTEGER DEFAULT 0,
          itematas INTEGER DEFAULT 0,
          vip INTEGER DEFAULT 0,
          viptanda INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT 0,
          updated_at INTEGER DEFAULT 0,
          FOREIGN KEY (room_name) REFERENCES rooms(room_name),
          UNIQUE(room_name, seat_number),
          UNIQUE(room_name, user_id)
        )
      `);

      // Tabel points
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_name TEXT,
          seat_number INTEGER,
          x INTEGER DEFAULT 0,
          y INTEGER DEFAULT 0,
          fast INTEGER DEFAULT 0,
          updated_at INTEGER DEFAULT 0,
          FOREIGN KEY (room_name) REFERENCES rooms(room_name),
          UNIQUE(room_name, seat_number)
        )
      `);

      // Tabel user_connections (untuk tracking multi-device)
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_connections (
          user_id TEXT,
          connection_id TEXT,
          room_name TEXT,
          seat_number INTEGER,
          is_multi INTEGER DEFAULT 0,
          connected_at INTEGER DEFAULT 0,
          last_active INTEGER DEFAULT 0,
          PRIMARY KEY (user_id, connection_id)
        )
      `);

      // Initialize rooms
      for (const room of ROOMS) {
        await this.db.prepare(`
          INSERT OR IGNORE INTO rooms (room_name, muted, number, last_activity)
          VALUES (?, 0, 1, ?)
        `).bind(room, Date.now()).run();
      }

    } catch (e) {
      console.error("Database init error:", e);
    }
  }

  async getRoom(roomName) {
    const result = await this.db.prepare(
      'SELECT * FROM rooms WHERE room_name = ?'
    ).bind(roomName).first();
    return result;
  }

  async updateRoomActivity(roomName) {
    await this.db.prepare(`
      UPDATE rooms SET last_activity = ? WHERE room_name = ?
    `).bind(Date.now(), roomName).run();
  }

  async setRoomMuted(roomName, muted) {
    await this.db.prepare(`
      UPDATE rooms SET muted = ?, last_activity = ? WHERE room_name = ?
    `).bind(muted ? 1 : 0, Date.now(), roomName).run();
  }

  async setRoomNumber(roomName, number) {
    await this.db.prepare(`
      UPDATE rooms SET number = ? WHERE room_name = ?
    `).bind(number, roomName).run();
  }

  async getSeat(roomName, seatNumber) {
    const result = await this.db.prepare(`
      SELECT * FROM seats WHERE room_name = ? AND seat_number = ?
    `).bind(roomName, seatNumber).first();
    return result;
  }

  async getAllSeats(roomName) {
    const results = await this.db.prepare(`
      SELECT * FROM seats WHERE room_name = ?
    `).bind(roomName).all();
    return results.results || [];
  }

  async getSeatsCount(roomName) {
    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM seats WHERE room_name = ?
    `).bind(roomName).first();
    return result?.count || 0;
  }

  async addSeat(roomName, seatNumber, userId, noimageUrl, color, itembawah, itematas, vip, viptanda) {
    try {
      await this.db.prepare(`
        INSERT INTO seats (room_name, seat_number, user_id, noimage_url, color, itembawah, itematas, vip, viptanda, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_name, seat_number) DO UPDATE SET
          user_id = excluded.user_id,
          noimage_url = excluded.noimage_url,
          color = excluded.color,
          itembawah = excluded.itembawah,
          itematas = excluded.itematas,
          vip = excluded.vip,
          viptanda = excluded.viptanda,
          updated_at = excluded.updated_at
      `).bind(
        roomName, seatNumber, userId, noimageUrl || "", color || "",
        itembawah || 0, itematas || 0, vip || 0, viptanda || 0,
        Date.now(), Date.now()
      ).run();

      await this.updateRoomActivity(roomName);
      return true;
    } catch (e) {
      console.error("Add seat error:", e);
      return false;
    }
  }

  async removeSeat(roomName, seatNumber) {
    try {
      await this.db.prepare(`
        DELETE FROM seats WHERE room_name = ? AND seat_number = ?
      `).bind(roomName, seatNumber).run();

      await this.db.prepare(`
        DELETE FROM points WHERE room_name = ? AND seat_number = ?
      `).bind(roomName, seatNumber).run();

      await this.updateRoomActivity(roomName);
      return true;
    } catch (e) {
      console.error("Remove seat error:", e);
      return false;
    }
  }

  async removeUserFromAllSeats(userId) {
    try {
      const seat = await this.db.prepare(`
        SELECT room_name, seat_number FROM seats WHERE user_id = ?
      `).bind(userId).first();

      if (seat) {
        await this.removeSeat(seat.room_name, seat.seat_number);
        return seat;
      }
      return null;
    } catch (e) {
      console.error("Remove user from seats error:", e);
      return null;
    }
  }

  async updatePoint(roomName, seatNumber, x, y, fast) {
    try {
      await this.db.prepare(`
        INSERT INTO points (room_name, seat_number, x, y, fast, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_name, seat_number) DO UPDATE SET
          x = excluded.x,
          y = excluded.y,
          fast = excluded.fast,
          updated_at = excluded.updated_at
      `).bind(roomName, seatNumber, x || 0, y || 0, fast ? 1 : 0, Date.now()).run();

      await this.updateRoomActivity(roomName);
      return true;
    } catch (e) {
      console.error("Update point error:", e);
      return false;
    }
  }

  async getPoints(roomName) {
    const results = await this.db.prepare(`
      SELECT * FROM points WHERE room_name = ?
    `).bind(roomName).all();
    return results.results || [];
  }

  async getPoint(roomName, seatNumber) {
    const result = await this.db.prepare(`
      SELECT * FROM points WHERE room_name = ? AND seat_number = ?
    `).bind(roomName, seatNumber).first();
    return result;
  }

  async getAllRooms() {
    const results = await this.db.prepare(`
      SELECT * FROM rooms
    `).all();
    return results.results || [];
  }

  async cleanupInactiveRooms(timeout = 3600000) {
    const now = Date.now();
    const results = await this.db.prepare(`
      SELECT r.room_name FROM rooms r
      LEFT JOIN seats s ON r.room_name = s.room_name
      WHERE r.last_activity < ? AND s.room_name IS NULL
    `).bind(now - timeout).all();

    return results.results || [];
  }
}

// ==================== CHAT SERVER ====================
export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.closing = false;
    this.isDestroyed = false;
    this.ROOMS = ROOMS;
    this.ROOMS_SET = ROOMS_SET;
    
    // WebSocket connections
    this.wsSet = new Set();
    this.userConnections = new Map();
    this.userSeat = new Map();
    this.userRoom = new Map();
    this.roomClients = new Map();
    this.wsActiveMulti = new Map();
    
    // Rate limiting
    this._processingMessages = new Set();
    this._cleaningUp = new Set();
    this._pendingTimeouts = new Set();
    
    // Locks
    this._joinLocks = new Map();
    this._kursiLocks = new Map();
    
    // Rate limiting per room
    this._roomMessageCount = new Map();
    this._roomMessageReset = new Map();
    
    this.currentNumber = 1;
    this._tikCounter = 0;
    this._cleanupInProgress = false;
    
    // Database helper
    this.db = new DatabaseHelper(env.DB);
    
    // Initialize rooms in DB
    this._initPromise = this.db.initTables().catch(e => console.error("DB init error:", e));
    
    // Setup room clients
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this._setupPeriodicCleanup();
    
    try {
      this.state.storage.setAlarm(Date.now() + C.ALARM_10_DETIK);
    } catch(e) {}
  }
  
  _setupPeriodicCleanup() {
    this._cleanupInterval = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this._cleanupInterval);
        return;
      }
      this._cleanupStaleLocks();
      this._cleanupMemory();
      this._cleanupDbRooms();
    }, C.CLEANUP_INTERVAL);
    
    this._pendingTimeouts.add(this._cleanupInterval);
  }
  
  async _cleanupDbRooms() {
    try {
      const inactiveRooms = await this.db.cleanupInactiveRooms();
      for (const room of inactiveRooms) {
        console.log(`Room ${room.room_name} is inactive`);
      }
    } catch(e) {}
  }
  
  _cleanupStaleLocks() {
    try {
      const now = Date.now();
      
      for (const [key, time] of this._joinLocks) {
        if (now - time > C.LOCK_TIMEOUT) {
          this._joinLocks.delete(key);
        }
      }
      
      for (const [key, time] of this._kursiLocks) {
        if (now - time > C.LOCK_TIMEOUT) {
          this._kursiLocks.delete(key);
        }
      }
      
      for (const [room, resetTime] of this._roomMessageReset) {
        if (now > resetTime + 60000) {
          this._roomMessageCount.delete(room);
          this._roomMessageReset.delete(room);
        }
      }
    } catch(e) {}
  }
  
  _cleanupMemory() {
    try {
      for (const [username, connections] of this.userConnections) {
        const toRemove = [];
        for (const conn of connections) {
          if (!conn || conn.readyState !== 1 || conn._closing || this._cleaningUp.has(conn)) {
            toRemove.push(conn);
          }
        }
        for (const conn of toRemove) {
          connections.delete(conn);
        }
        if (connections.size === 0) {
          this.userConnections.delete(username);
        }
      }
      
      for (const [room, clients] of this.roomClients) {
        const toRemove = [];
        for (const client of clients) {
          if (!client || client.readyState !== 1 || client._closing || this._cleaningUp.has(client)) {
            toRemove.push(client);
          }
        }
        for (const client of toRemove) {
          clients.delete(client);
        }
      }
    } catch(e) {}
  }
  
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    try {
      this._tikCounter++;
      
      if (this._tikCounter >= C.NUMBER_UPDATE_TIK) {
        this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
        
        for (const room of ROOMS) {
          await this.db.setRoomNumber(room, this.currentNumber);
        }
        
        const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
        
        for (const [room, clients] of this.roomClients) {
          if (clients && clients.size > 0 && clients.size <= C.MAX_ROOM_CLIENTS) {
            this._broadcastToRoom(room, numberMsg);
          }
        }
        
        this._tikCounter = 0;
      }
      
      this._doCleanup();
      
    } catch(e) {}
    
    try {
      this.state.storage.setAlarm(Date.now() + C.ALARM_10_DETIK);
    } catch(e) {}
  }
  
  _doCleanup() {
    if (this._cleanupInProgress || this.closing || this.isDestroyed) return;
    this._cleanupInProgress = true;
    
    try {
      const toRemove = [];
      for (const ws of this.wsSet) {
        if (!ws || ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws)) {
          toRemove.push(ws);
        }
      }
      for (const ws of toRemove) {
        this.cleanup(ws);
      }
    } catch(e) {} finally {
      this._cleanupInProgress = false;
    }
  }
  
  _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed || !room) return;
    
    const clients = this.roomClients.get(room);
    if (!clients || clients.size === 0) return;
    
    if (clients.size > C.MAX_ROOM_CLIENTS) return;
    
    const clientArray = Array.from(clients);
    const BATCH_SIZE = C.BATCH_SIZE;
    const toRemove = new Set();
    
    for (let i = 0; i < clientArray.length; i += BATCH_SIZE) {
      const batch = clientArray.slice(i, Math.min(i + BATCH_SIZE, clientArray.length));
      
      for (const ws of batch) {
        if (!ws) {
          toRemove.add(ws);
          continue;
        }
        
        try {
          if (ws.readyState === 1 && !ws._closing && !this._cleaningUp.has(ws)) {
            ws.send(msgStr);
          } else {
            toRemove.add(ws);
          }
        } catch(e) {
          toRemove.add(ws);
        }
      }
    }
    
    if (toRemove.size > 0) {
      for (const ws of toRemove) {
        try {
          clients.delete(ws);
          if (ws && !this._cleaningUp.has(ws)) {
            this.cleanup(ws);
          }
        } catch(e) {}
      }
    }
  }
  
  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try {
      this._broadcastToRoom(room, JSON.stringify(msg));
    } catch(e) {}
  }
  
  safeSend(ws, msg) {
    if (!ws) return false;
    
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
        return false;
      }
      
      ws.send(JSON.stringify(msg));
      return true;
    } catch(e) {
      this.cleanup(ws);
      return false;
    }
  }
  
  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    try {
      const count = await this.db.getSeatsCount(room);
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) {
      return 0;
    }
  }
  
  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
        return;
      }
    } catch(e) {
      return;
    }
    
    try {
      const count = await this.db.getSeatsCount(room);
      this.safeSend(ws, ["roomUserCount", room, count]);
      
      const allSeats = await this.db.getAllSeats(room);
      if (allSeats && allSeats.length > 0) {
        const seatsMap = {};
        for (const seat of allSeats) {
          seatsMap[seat.seat_number] = {
            noimageUrl: seat.noimage_url || "",
            namauser: seat.user_id || "",
            color: seat.color || "",
            itembawah: seat.itembawah || 0,
            itematas: seat.itematas || 0,
            vip: seat.vip || 0,
            viptanda: seat.viptanda || 0,
          };
        }
        
        const selfSeat = this.userSeat.get(ws.username)?.seat;
        if (excludeSelf && selfSeat && seatsMap[selfSeat]) {
          delete seatsMap[selfSeat];
        }
        
        if (Object.keys(seatsMap).length > 0) {
          this.safeSend(ws, ["allUpdateKursiList", room, seatsMap]);
        }
      }
      
      const allPoints = await this.db.getPoints(room);
      if (allPoints && allPoints.length > 0) {
        let filteredPoints = allPoints.map(p => ({
          seat: p.seat_number,
          x: p.x,
          y: p.y,
          fast: p.fast
        }));
        
        const selfSeat = this.userSeat.get(ws.username)?.seat;
        if (excludeSelf && selfSeat) {
          filteredPoints = filteredPoints.filter(p => p.seat !== selfSeat);
        }
        
        if (filteredPoints.length > 0) {
          this.safeSend(ws, ["allPointsList", room, filteredPoints]);
        }
      }
    } catch(e) {}
  }
  
  cleanup(ws) {
    if (!ws || ws._cleaning || this._cleaningUp.has(ws)) {
      return;
    }
    
    ws._cleaning = true;
    this._cleaningUp.add(ws);
    
    try {
      const username = ws.username;
      const room = ws.room;
      
      if (room) {
        try {
          const clients = this.roomClients.get(room);
          if (clients) clients.delete(ws);
        } catch(e) {}
      }
      
      try {
        const activeData = this.wsActiveMulti.get(ws);
        if (activeData?.room) {
          const clients = this.roomClients.get(activeData.room);
          if (clients) clients.delete(ws);
        }
        this.wsActiveMulti.delete(ws);
      } catch(e) {}
      
      if (username) {
        try {
          const connections = this.userConnections.get(username);
          if (connections) {
            connections.delete(ws);
            
            const seatInfo = this.userSeat.get(username);
            const isMulti = seatInfo?.isMulti === true;
            
            if (!isMulti && connections.size === 0) {
              this.userConnections.delete(username);
              
              if (seatInfo?.room) {
                this.db.removeSeat(seatInfo.room, seatInfo.seat).catch(e => {});
                this.broadcast(seatInfo.room, ["removeKursi", seatInfo.room, seatInfo.seat]);
                this.updateRoomCount(seatInfo.room).catch(e => {});
              }
              
              this.userSeat.delete(username);
              this.userRoom.delete(username);
            }
          }
        } catch(e) {}
      }
      
      try {
        this.wsSet.delete(ws);
      } catch(e) {}
      
    } catch(e) {} finally {
      ws._cleaning = false;
      this._cleaningUp.delete(ws);
      
      try {
        if (ws && ws.readyState === 1) {
          ws.close(1000, "Cleanup");
        }
      } catch(e) {}
    }
  }
  
  async handleMessage(ws, raw) {
    if (!ws) return;
    
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
        return;
      }
    } catch(e) {
      return;
    }
    
    if (this._processingMessages.has(ws)) return;
    this._processingMessages.add(ws);
    
    try {
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) return;
      
      let data;
      try { 
        data = JSON.parse(str); 
      } catch(e) { 
        return; 
      }
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      
      if (evt === "chat" || evt === "updatePoint" || evt === "gift" || evt === "rollangak") {
        const room = args[0];
        if (room && !ROOMS_SET.has(room)) return;
      }
      
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
          
          try {
            const existing = await this.db.removeUserFromAllSeats(multiUsername);
            if (existing) {
              this.broadcast(existing.room_name, ["removeKursi", existing.room_name, existing.seat_number]);
              await this.updateRoomCount(existing.room_name);
            }
            this.userSeat.delete(multiUsername);
            this.userRoom.delete(multiUsername);
          } catch(e) {}
          
          const count = await this.db.getSeatsCount(multiRoomname);
          if (count >= C.MAX_SEATS) break;
          
          let seat = 1;
          const existingSeats = await this.db.getAllSeats(multiRoomname);
          const takenSeats = new Set(existingSeats.map(s => s.seat_number));
          while (takenSeats.has(seat)) seat++;
          
          if (seat > C.MAX_SEATS) break;
          
          const added = await this.db.addSeat(multiRoomname, seat, multiUsername, "", "", 0, 0, 0, 0);
          if (!added) break;
          
          try {
            this.userSeat.set(multiUsername, { room: multiRoomname, seat, isMulti: true });
            this.userRoom.set(multiUsername, multiRoomname);
            
            let connections = this.userConnections.get(multiUsername);
            if (!connections) connections = new Set();
            if (!connections.has(ws)) connections.add(ws);
            this.userConnections.set(multiUsername, connections);
            
            this.wsActiveMulti.set(ws, { username: multiUsername, room: multiRoomname });
            const roomClients = this.roomClients.get(multiRoomname);
            if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
            
            this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
            await this.updateRoomCount(multiRoomname);
          } catch(e) {}
          break;
        }
        
        case "exitMulti": {
          const targetUsername = args[0];
          if (!targetUsername) break;
          
          try {
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
            
            await this.db.removeSeat(roomName, seatNumber);
            this.broadcast(roomName, ["removeKursi", roomName, seatNumber]);
            await this.updateRoomCount(roomName);
            
            this.userSeat.delete(targetUsername);
            this.userRoom.delete(targetUsername);
            
            const connections = this.userConnections.get(targetUsername);
            if (connections) {
              connections.delete(ws);
              if (connections.size === 0) {
                this.userConnections.delete(targetUsername);
              }
            }
            
            if (ws.username === targetUsername) {
              ws.username = null;
              ws.idtarget = null;
            }
          } catch(e) {}
          break;
        }
        
        case "setActiveMulti": {
          const targetUsername = args[0];
          try {
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
            const roomClients = this.roomClients.get(roomName);
            if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
            
            ws.username = targetUsername;
            ws.idtarget = targetUsername;
            ws.room = roomName;
            ws.roomname = roomName;
            
            this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
            this.broadcast(roomName, ["userActiveChanged", targetUsername, seatNumber]);
          } catch(e) {}
          break;
        }
        
        case "updateKursi": {
          try {
            const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt] = args;
            
            const lockKey = `kursi_${kursiRoom}_${kursiSeat}`;
            
            if (this._kursiLocks.has(lockKey)) {
              break;
            }
            
            this._kursiLocks.set(lockKey, Date.now());
            
            try {
              const updated = await this.db.addSeat(
                kursiRoom, kursiSeat, kursiName, kursiNoimg, kursiColor,
                kursiBawah, kursiAtas, kursiVip, kursiVt
              );
              
              if (updated) {
                const updatedSeat = await this.db.getSeat(kursiRoom, kursiSeat);
                if (updatedSeat) {
                  const seatData = {
                    noimageUrl: updatedSeat.noimage_url || "",
                    namauser: updatedSeat.user_id || "",
                    color: updatedSeat.color || "",
                    itembawah: updatedSeat.itembawah || 0,
                    itematas: updatedSeat.itematas || 0,
                    vip: updatedSeat.vip || 0,
                    viptanda: updatedSeat.viptanda || 0,
                  };
                  this.broadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, seatData]]]);
                }
              }
            } finally {
              this._kursiLocks.delete(lockKey);
            }
          } catch(e) {}
          break;
        }
        
        case "chat": {
          try {
            const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
            
            if (!chatMsg || !ROOMS_SET.has(chatRoom)) break;
            
            const now = Date.now();
            const reset = this._roomMessageReset.get(chatRoom) || 0;
            const count = this._roomMessageCount.get(chatRoom) || 0;
            
            if (now > reset) {
              this._roomMessageReset.set(chatRoom, now + 1000);
              this._roomMessageCount.set(chatRoom, 1);
            } else {
              if (count > 10) {
                break;
              }
              this._roomMessageCount.set(chatRoom, count + 1);
            }
            
            if (!ws._chatTime) ws._chatTime = 0;
            if (!ws._chatCount) ws._chatCount = 0;
            
            if (now - ws._chatTime > 1000) {
              ws._chatCount = 1;
              ws._chatTime = now;
            } else {
              ws._chatCount++;
              if (ws._chatCount > 2) {
                break;
              }
            }
            
            const clients = this.roomClients.get(chatRoom);
            if (!clients || clients.size === 0) break;
            
            this._broadcastToRoom(chatRoom, JSON.stringify(["chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor]));
          } catch(e) {}
          break;
        }
        
        case "updatePoint": {
          try {
            const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
            if (pointRoom && typeof pointSeat === 'number' && pointSeat >= 1 && pointSeat <= C.MAX_SEATS) {
              const seat = await this.db.getSeat(pointRoom, pointSeat);
              if (seat) {
                await this.db.updatePoint(pointRoom, pointSeat, pointX, pointY, pointFast === 1);
                this._broadcastToRoom(pointRoom, JSON.stringify(["pointUpdated", pointRoom, pointSeat, pointX, pointY, pointFast]));
              }
            }
          } catch(e) {}
          break;
        }
        
        case "removeKursiAndPoint": {
          try {
            const [removeRoom, removeSeat] = args;
            const seat = await this.db.getSeat(removeRoom, removeSeat);
            if (seat) {
              for (const [username, info] of this.userSeat) {
                if (info.seat === removeSeat && info.room === removeRoom) {
                  this.userSeat.delete(username);
                  this.userRoom.delete(username);
                  break;
                }
              }
              await this.db.removeSeat(removeRoom, removeSeat);
              this.broadcast(removeRoom, ["removeKursi", removeRoom, removeSeat]);
              await this.updateRoomCount(removeRoom);
            }
          } catch(e) {}
          break;
        }
        
        case "private": {
          try {
            const [privTarget, privNoimg, privMsg, privSender] = args;
            if (privTarget && privMsg) {
              const targetConns = this.userConnections.get(privTarget);
              if (targetConns) {
                for (const targetWs of targetConns) {
                  if (targetWs?.readyState === 1) {
                    this.safeSend(targetWs, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
                    break;
                  }
                }
              }
              this.safeSend(ws, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
            }
          } catch(e) {}
          break;
        }
        
        case "gift": {
          try {
            const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
            if (giftRoom && ROOMS_SET.has(giftRoom)) {
              const now = Date.now();
              if (!ws._giftTime) ws._giftTime = 0;
              if (!ws._giftCount) ws._giftCount = 0;
              
              if (now - ws._giftTime > 1000) {
                ws._giftCount = 1;
                ws._giftTime = now;
              } else {
                ws._giftCount++;
                if (ws._giftCount > 3) {
                  break;
                }
              }
              
              const clients = this.roomClients.get(giftRoom);
              if (!clients || clients.size === 0) break;
              this._broadcastToRoom(giftRoom, JSON.stringify(["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]));
            }
          } catch(e) {}
          break;
        }
        
        case "rollangak": {
          try {
            const [rollRoom, rollUser, rollAngka] = args;
            if (rollRoom && ROOMS_SET.has(rollRoom)) {
              const now = Date.now();
              if (!ws._rollTime) ws._rollTime = 0;
              if (!ws._rollCount) ws._rollCount = 0;
              
              if (now - ws._rollTime > 1000) {
                ws._rollCount = 1;
                ws._rollTime = now;
              } else {
                ws._rollCount++;
                if (ws._rollCount > 2) {
                  break;
                }
              }
              
              const clients = this.roomClients.get(rollRoom);
              if (!clients || clients.size === 0) break;
              this._broadcastToRoom(rollRoom, JSON.stringify(["rollangakBroadcast", rollRoom, rollUser, rollAngka]));
            }
          } catch(e) {}
          break;
        }
        
        case "sendnotif": {
          try {
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
          } catch(e) {}
          break;
        }
        
        case "getCurrentNumber":
          try { this.safeSend(ws, ["currentNumber", this.currentNumber]); } catch(e) {}
          break;
        
        case "isUserOnline": {
          try {
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
          } catch(e) {}
          break;
        }
        
        case "getOnlineUsers": {
          try {
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
          } catch(e) {}
          break;
        }
        
        case "getAllRoomsUserCount": {
          try {
            const counts = {};
            for (const room of ROOMS) {
              const count = await this.db.getSeatsCount(room);
              counts[room] = count;
            }
            this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
          } catch(e) {}
          break;
        }
        
        case "getRoomUserCount": {
          try {
            const roomName = args[0];
            if (roomName && ROOMS_SET.has(roomName)) {
              const count = await this.db.getSeatsCount(roomName);
              this.safeSend(ws, ["roomUserCount", roomName, count]);
            }
          } catch(e) {}
          break;
        }
        
        case "setMuteType": {
          try {
            const [muteVal, muteRoom] = args;
            if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
            
            await this.db.setRoomMuted(muteRoom, muteVal);
            this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
            this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
          } catch(e) {}
          break;
        }

        case "modwarning": {
          try {
            const modRoom = args[0];
            if (modRoom && ROOMS_SET.has(modRoom)) {
              this.broadcast(modRoom, ["modwarning", modRoom]);
            }
          } catch(e) {}
          break;
        }

        case "getMuteType": {
          try {
            const getMuteRoom = args[0];
            if (getMuteRoom && ROOMS_SET.has(getMuteRoom)) {
              const roomData = await this.db.getRoom(getMuteRoom);
              this.safeSend(ws, ["muteTypeResponse", roomData?.muted || false, getMuteRoom]);
            }
          } catch(e) {}
          break;
        }
        
        case "onDestroy":
          await this.cleanup(ws);
          break;
        
        default:
          try { this.safeSend(ws, ["error", `Unknown event: ${evt}`]); } catch(e) {}
          break;
      }
      
    } catch(e) {} finally {
      try {
        this._processingMessages.delete(ws);
      } catch(e) {}
    }
  }
  
  async handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { 
        if (ws?.readyState === 1) ws.close(1000, "Invalid username"); 
      } catch(e) {}
      return;
    }
    
    if (ws.readyState !== 1) {
      try {
        this.cleanup(ws);
      } catch(e) {}
      return;
    }
    
    const existingSeatInfo = this.userSeat.get(username);
    if (existingSeatInfo?.isMulti === true && isNewUser === false) {
      try {
        const oldConnections = this.userConnections.get(username);
        if (oldConnections) {
          const toRemove = [];
          for (const conn of oldConnections) {
            if (!conn || conn.readyState !== 1 || conn._closing) {
              toRemove.push(conn);
            }
          }
          for (const conn of toRemove) {
            oldConnections.delete(conn);
            this.wsSet.delete(conn);
            this.wsActiveMulti.delete(conn);
          }
        }
        
        let connections = this.userConnections.get(username);
        if (!connections) {
          connections = new Set();
          this.userConnections.set(username, connections);
        }
        if (!connections.has(ws)) {
          connections.add(ws);
        }
        
        if (!this.wsSet.has(ws)) {
          this.wsSet.add(ws);
        }
        
        ws.username = username;
        ws.idtarget = username;
        ws.room = null;
        ws.roomname = null;
        ws._closing = false;
        
        this.safeSend(ws, ["multiUserActive", username]);
        
      } catch(e) {}
      
      return;
    }
    
    try {
      const oldConnections = this.userConnections.get(username);
      if (oldConnections) {
        const toRemove = [];
        for (const conn of oldConnections) {
          if (!conn || conn.readyState !== 1 || conn._closing) {
            toRemove.push(conn);
          }
        }
        for (const conn of toRemove) {
          oldConnections.delete(conn);
          this.wsSet.delete(conn);
          this.wsActiveMulti.delete(conn);
        }
        if (oldConnections.size === 0) {
          this.userConnections.delete(username);
        }
      }
      
      const existing = await this.db.removeUserFromAllSeats(username);
      if (existing) {
        this.broadcast(existing.room_name, ["removeKursi", existing.room_name, existing.seat_number]);
        await this.updateRoomCount(existing.room_name);
      }
      
      this.userSeat.delete(username);
      this.userRoom.delete(username);
      
      try {
        ws.username = username;
        ws.idtarget = username;
        ws.room = null;
        ws.roomname = null;
        ws._closing = false;
        
        let connections = this.userConnections.get(username);
        if (!connections) {
          connections = new Set();
          this.userConnections.set(username, connections);
        }
        if (!connections.has(ws)) {
          connections.add(ws);
        }
        
        if (!this.wsSet.has(ws)) {
          this.wsSet.add(ws);
        }
        
      } catch(e) {}
      
      try {
        if (isNewUser) {
          this.safeSend(ws, ["joinroomawal"]);
        } else {
          this.safeSend(ws, ["needJoinRoom"]);
        }
      } catch(e) {}
      
    } catch(e) {}
  }
  
  async handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    const lockKey = `join_${roomName}_${username}`;
    
    if (this._joinLocks.has(lockKey)) {
      this.safeSend(ws, ["roomFull", roomName]);
      return false;
    }
    
    this._joinLocks.set(lockKey, Date.now());
    
    try {
      return await this._handleJoinInternal(ws, roomName, username);
    } finally {
      this._joinLocks.delete(lockKey);
    }
  }
  
  async _handleJoinInternal(ws, roomName, username) {
    const oldRoom = ws.room;
    
    if (oldRoom && oldRoom !== roomName) {
      try {
        const oldSeat = this.userSeat.get(username)?.seat;
        if (oldSeat) {
          await this.db.removeSeat(oldRoom, oldSeat);
          this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
          await this.updateRoomCount(oldRoom);
        }
        const oldClients = this.roomClients.get(oldRoom);
        if (oldClients) oldClients.delete(ws);
        this.userSeat.delete(username);
        this.userRoom.delete(username);
      } catch(e) {}
      ws.room = null;
      ws.roomname = null;
    }
    
    const existingSeats = await this.db.getAllSeats(roomName);
    let seat = null;
    for (const s of existingSeats) {
      if (s.user_id === username) { 
        seat = s.seat_number; 
        break; 
      }
    }
    
    if (!seat) {
      const count = existingSeats.length;
      if (count >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      const takenSeats = new Set(existingSeats.map(s => s.seat_number));
      seat = 1;
      while (takenSeats.has(seat)) seat++;
      
      if (seat > C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      await this.db.addSeat(roomName, seat, username, "", "", 0, 0, 0, 0);
    }
    
    try {
      this.userSeat.set(username, { room: roomName, seat, isMulti: false });
      this.userRoom.set(username, roomName);
      ws.room = roomName;
      ws.roomname = roomName;
      ws.idtarget = username;
      
      const roomClients = this.roomClients.get(roomName);
      if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
      
      const roomData = await this.db.getRoom(roomName);
      const count = await this.db.getSeatsCount(roomName);
      
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", roomData?.muted || false, roomName]);
      this.safeSend(ws, ["roomUserCount", roomName, count]);
      
      await this.updateRoomCount(roomName);
      
      const timeoutId = setTimeout(() => {
        try {
          if (ws && ws.readyState === 1 && !this.closing && !this.isDestroyed) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      
      this._pendingTimeouts.add(timeoutId);
      
    } catch(e) {}
    
    return true;
  }
  
  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    await this._initPromise;
    
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
      
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      
      const timeoutId = setTimeout(() => {
        try {
          if (server && server.readyState === 0) {
            server.close(1000, "Timeout");
          }
        } catch(e) {}
      }, 5000);
      
      server._timeoutId = timeoutId;
      this._pendingTimeouts.add(timeoutId);
      
      try { 
        this.state.acceptWebSocket(server);
      } catch(e) { 
        clearTimeout(timeoutId);
        this._pendingTimeouts.delete(timeoutId);
        return new Response("WebSocket acceptance failed", { status: 500 }); 
      }
      
      server.username = null;
      server.room = null;
      server.roomname = null;
      server.idtarget = null;
      server._closing = false;
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
    } catch(e) {}
  }
  
  async webSocketClose(ws) { 
    if (!ws) return;
    try {
      this.cleanup(ws);
    } catch(e) {}
  }
  
  async webSocketError(ws) { 
    if (!ws) return;
    try {
      this.cleanup(ws);
    } catch(e) {}
  }
  
  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    this._joinLocks.clear();
    this._kursiLocks.clear();
    
    for (const timeout of this._pendingTimeouts) {
      clearTimeout(timeout);
    }
    this._pendingTimeouts.clear();
    
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    
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
        this.cleanup(ws);
      } catch(e) {}
    }
    
    this.wsSet.clear();
    this.userConnections.clear();
    this.userSeat.clear();
    this.userRoom.clear();
    this.wsActiveMulti.clear();
    this.roomClients.clear();
    this._processingMessages.clear();
    this._cleaningUp.clear();
    this._roomMessageCount.clear();
    this._roomMessageReset.clear();
  }
}
