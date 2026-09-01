// ==================== CHAT-SERVER-HIBERNATION-NO-PING.JS ====================
// VERSION: 9.9.8 - FULL AUTO-SAVE ALL STATE

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000,
  MAX_NUMBER: 6,
  LOCK_TIMEOUT: 10000,
  BATCH_SIZE: 20,
  MAX_EVENT_QUEUE: 100,
  MAX_PROCESS_TIME_MS: 500,
  AUTO_SAVE_INTERVAL_MS: 30000, // 30 DETIK
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    this._isRestoring = false;
    this._lastAutoSave = Date.now();
    
    // ========== ROOM CLIENTS ==========
    this.roomClients = new Map();
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    // ========== DATA CACHE ==========
    this._roomsDataCache = {};
    this._userIndex = {};
    this.currentNumber = 1;
    this._onlineUsers = new Set();
    this._userCounts = {};
    for (const room of ROOMS) {
      this._userCounts[room] = 0;
    }
    
    // ========== MULTI ID TRACKING ==========
    this.wsActiveMulti = new Map();
    this.userConnections = new Map();
    this.userSeat = new Map();
    this.userRoom = new Map();
    
    // ========== LOCKS ==========
    this._joinLocks = new Map();
    this._kursiLocks = new Map();
    this._multiJoinLock = false;
    
    // ========== EVENT QUEUE ==========
    this._eventQueue = [];
    this._isProcessingQueue = false;
    this._processingMessages = new Set();
    
    this._isNumberUpdating = false;
    this._lastRefreshTime = 0;
    
    // ========== SAVE QUEUE ==========
    this._saveQueue = [];
    this._isSaving = false;
    this._pendingSaves = new Set();
    
    // ========== DEPLOY ==========
    this._checkAndResetOnDeploy().then(() => {
      this._restoreAllState().then(() => {
        this._startAutoSave();
      });
    });
  }

  // ============ AUTO-SAVE INTERVAL ============
  
  _startAutoSave() {
    if (this.closing || this.isDestroyed) return;
    
    // AUTO-SAVE EVERY 30 SECONDS
    this._autoSaveInterval = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this._autoSaveInterval);
        this._autoSaveInterval = null;
        return;
      }
      this._autoSaveAll();
    }, C.AUTO_SAVE_INTERVAL_MS);
  }

  async _autoSaveAll() {
    if (this._isSaving) return;
    this._isSaving = true;
    
    try {
      // SAVE ROOMS DATA
      await this._saveToStorage(
        this._roomsDataCache,
        this._userIndex,
        this.currentNumber
      );
      
      // SAVE ONLINE USERS
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      
      // SAVE USER COUNTS
      await this.ctx.storage.put("userCounts", this._userCounts);
      
      // SAVE MULTI ID STATE
      await this._saveMultiIdState();
      
      // SAVE ROOM MUTE STATES
      const muteStates = {};
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (roomData && roomData.muted !== undefined) {
          muteStates[roomName] = roomData.muted;
        }
      }
      await this.ctx.storage.put("muteStates", muteStates);
      
      // SAVE NUMBER STATES
      const numberStates = {};
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (roomData && roomData.number !== undefined) {
          numberStates[roomName] = roomData.number;
        }
      }
      await this.ctx.storage.put("numberStates", numberStates);
      
      // SAVE POINTS
      const pointsData = {};
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (roomData && roomData.points && Object.keys(roomData.points).length > 0) {
          pointsData[roomName] = roomData.points;
        }
      }
      await this.ctx.storage.put("pointsData", pointsData);
      
      this._lastAutoSave = Date.now();
      
    } catch(e) {} finally {
      this._isSaving = false;
    }
  }

  // ============ SAVE MULTI ID STATE ============

  async _saveMultiIdState() {
    try {
      const multiIdState = {
        userSeat: {},
        userRoom: {},
        userConnections: {},
        wsActiveMulti: {},
        onlineUsers: Array.from(this._onlineUsers),
        timestamp: Date.now()
      };
      
      // Save userSeat
      for (const [username, data] of this.userSeat) {
        if (data) {
          multiIdState.userSeat[username] = data;
        }
      }
      
      // Save userRoom
      for (const [username, room] of this.userRoom) {
        if (room) {
          multiIdState.userRoom[username] = room;
        }
      }
      
      // Save userConnections (only usernames, not WS references)
      for (const [username, connections] of this.userConnections) {
        if (connections && connections.size > 0) {
          multiIdState.userConnections[username] = connections.size;
        }
      }
      
      // Save wsActiveMulti
      for (const [ws, data] of this.wsActiveMulti) {
        if (ws && data && data.username) {
          // Use ws._wsId as key
          const wsId = ws._wsId || Date.now() + Math.random();
          multiIdState.wsActiveMulti[wsId] = data;
        }
      }
      
      await this.ctx.storage.put("multiIdState", multiIdState);
      
    } catch(e) {}
  }

  async _restoreMultiIdState() {
    try {
      const multiIdState = await this.ctx.storage.get("multiIdState");
      if (!multiIdState) return;
      
      // Restore onlineUsers
      if (multiIdState.onlineUsers) {
        for (const username of multiIdState.onlineUsers) {
          this._onlineUsers.add(username);
        }
      }
      
      // Restore userSeat & userRoom
      if (multiIdState.userSeat) {
        for (const [username, data] of Object.entries(multiIdState.userSeat)) {
          if (data && data.room && data.seat) {
            this.userSeat.set(username, data);
            if (multiIdState.userRoom && multiIdState.userRoom[username]) {
              this.userRoom.set(username, multiIdState.userRoom[username]);
            }
          }
        }
      }
      
      // Restore userConnections from WebSockets
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            const username = attachment.username;
            const isMulti = attachment.isMulti || false;
            const room = attachment.room || attachment.multiRoom || null;
            const seat = attachment.seat || attachment.multiSeat || null;
            
            if (username) {
              let connections = this.userConnections.get(username);
              if (!connections) {
                connections = new Set();
                this.userConnections.set(username, connections);
              }
              if (!connections.has(ws)) {
                connections.add(ws);
              }
              
              ws.username = username;
              ws._cachedUsername = username;
              ws._isMulti = isMulti;
              
              if (isMulti && room && seat) {
                ws._multiRoom = room;
                ws._multiSeat = seat;
                ws._cachedRoom = room;
                ws.room = room;
                ws.roomname = room;
                
                this.wsActiveMulti.set(ws, { username, room });
                
                const roomClients = this.roomClients.get(room);
                if (roomClients && !roomClients.has(ws)) {
                  roomClients.add(ws);
                }
                
                if (!this.userSeat.has(username)) {
                  this.userSeat.set(username, { room, seat, isMulti: true });
                  this.userRoom.set(username, room);
                }
                
                this._onlineUsers.add(username);
              } else if (room && seat) {
                ws.room = room;
                ws.roomname = room;
                ws._cachedRoom = room;
                ws._multiRoom = null;
                ws._multiSeat = null;
                
                const roomClients = this.roomClients.get(room);
                if (roomClients && !roomClients.has(ws)) {
                  roomClients.add(ws);
                }
                
                if (!this.userSeat.has(username)) {
                  this.userSeat.set(username, { room, seat, isMulti: false });
                  this.userRoom.set(username, room);
                }
              }
            }
          }
        } catch(e) {}
      }
      
      // Cleanup invalid userSeat
      const toRemove = [];
      for (const [username, data] of this.userSeat) {
        if (!data) {
          toRemove.push(username);
          continue;
        }
        
        const connections = this.userConnections.get(username);
        if (!connections || connections.size === 0) {
          let hasActive = false;
          for (const ws of webSockets) {
            try {
              const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
              if (uname === username && ws.readyState === 1) {
                hasActive = true;
                break;
              }
            } catch(e) {}
          }
          if (!hasActive && !data.isMulti) {
            toRemove.push(username);
          }
        }
      }
      
      for (const username of toRemove) {
        this.userSeat.delete(username);
        this.userRoom.delete(username);
        this.userConnections.delete(username);
        this._onlineUsers.delete(username);
      }
      
    } catch(e) {}
  }

  // ============ SYNC CACHE & STORAGE ============

  async _syncAllData() {
    await this._saveToStorage(
      this._roomsDataCache,
      this._userIndex,
      this.currentNumber
    );
    await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
    await this.ctx.storage.put("userCounts", this._userCounts);
    await this._saveMultiIdState();
  }

  async _checkAndResetOnDeploy() {
    try {
      const storedVersion = await this.ctx.storage.get("deployVersion");
      const currentVersion = "9.9.8";
      
      if (storedVersion !== currentVersion) {
        this._roomsDataCache = {};
        this._userIndex = {};
        this.currentNumber = 1;
        this._onlineUsers.clear();
        this._userCounts = {};
        this.userSeat.clear();
        this.userRoom.clear();
        this.userConnections.clear();
        this.wsActiveMulti.clear();
        
        for (const room of ROOMS) {
          this._userCounts[room] = 0;
        }
        
        await this.ctx.storage.delete("roomsData");
        await this.ctx.storage.delete("userIndex");
        await this.ctx.storage.delete("currentNumber");
        await this.ctx.storage.delete("userCounts");
        await this.ctx.storage.delete("onlineUsers");
        await this.ctx.storage.delete("multiIdState");
        await this.ctx.storage.delete("muteStates");
        await this.ctx.storage.delete("numberStates");
        await this.ctx.storage.delete("pointsData");
        
        await this.ctx.storage.put("deployVersion", currentVersion);
        await this.ctx.storage.put("lastReset", Date.now());
        
        const resetMessage = JSON.stringify(["serverReset", "Server updated - All data reset"]);
        const webSockets = this._getActiveWebSockets();
        for (const ws of webSockets) {
          try {
            if (ws.readyState === 1) {
              ws.send(resetMessage);
              ws.close(1000, "Server updated");
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  _getActiveWebSockets() {
    try {
      return this.ctx.getWebSockets();
    } catch(e) {
      return [];
    }
  }

  _refreshRoomClients(force = false) {
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      try {
        let room = ws._cachedRoom;
        let username = ws._cachedUsername;
        
        if (!room || !username) {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username && attachment.room) {
            room = attachment.room;
            username = attachment.username;
            ws._cachedRoom = room;
            ws._cachedUsername = username;
          }
        }
        
        if (room && username) {
          const roomClients = this.roomClients.get(room);
          if (roomClients) {
            roomClients.add(ws);
          }
        }
      } catch(e) {}
    }
  }

  async _saveToStorage(roomsData, userIndex, currentNumber) {
    try {
      const updates = {};
      if (roomsData !== undefined) {
        this._roomsDataCache = roomsData;
        updates.roomsData = roomsData;
      }
      if (userIndex !== undefined) {
        this._userIndex = userIndex;
        updates.userIndex = userIndex;
      }
      if (currentNumber !== undefined) {
        this.currentNumber = currentNumber;
        updates.currentNumber = currentNumber;
      }
      
      if (Object.keys(updates).length > 0) {
        await this.ctx.storage.put(updates);
      }
    } catch(e) {
      try {
        const storage = await this.ctx.storage.get(["roomsData", "userIndex", "currentNumber"]);
        if (storage.roomsData !== undefined) this._roomsDataCache = storage.roomsData;
        if (storage.userIndex !== undefined) this._userIndex = storage.userIndex;
        if (storage.currentNumber !== undefined) this.currentNumber = storage.currentNumber;
      } catch(err) {}
      throw e;
    }
  }

  // ============ USER INDEX OPERATIONS ============

  _addUserToIndex(username, roomName, seat) {
    if (!this._userIndex[username]) {
      this._userIndex[username] = { rooms: {}, isMulti: false };
    }
    this._userIndex[username].rooms[roomName] = seat;
  }

  _removeUserFromIndex(username, roomName) {
    if (this._userIndex[username]) {
      delete this._userIndex[username].rooms[roomName];
      if (Object.keys(this._userIndex[username].rooms).length === 0) {
        delete this._userIndex[username];
      }
    }
  }

  _removeUserFromAllIndex(username) {
    if (this._userIndex[username]) {
      delete this._userIndex[username];
    }
  }

  _getUserRooms(username) {
    if (this._userIndex[username]) {
      return this._userIndex[username].rooms;
    }
    return {};
  }

  _isUserInRoom(username, roomName) {
    if (this._userIndex[username]) {
      return this._userIndex[username].rooms.hasOwnProperty(roomName);
    }
    return false;
  }

  _getUserSeat(username, roomName) {
    if (this._userIndex[username]) {
      return this._userIndex[username].rooms[roomName] || null;
    }
    return null;
  }

  _setUserMulti(username, isMulti) {
    if (!this._userIndex[username]) {
      this._userIndex[username] = { rooms: {}, isMulti: false };
    }
    this._userIndex[username].isMulti = isMulti;
  }

  _isUserMulti(username) {
    if (this._userIndex[username]) {
      return this._userIndex[username].isMulti || false;
    }
    return false;
  }

  _findAvailableSeat(roomData, username) {
    for (const [seat, data] of Object.entries(roomData.seats)) {
      if (data && data.namauser === username) {
        return parseInt(seat);
      }
    }
    
    for (let s = 1; s <= C.MAX_SEATS; s++) {
      if (!roomData.seats[s]) {
        return s;
      }
    }
    
    return null;
  }

  async _updateUserCounts() {
    try {
      const newCounts = {};
      let totalUsers = 0;
      
      for (const room of ROOMS) {
        const roomData = this._roomsDataCache[room];
        const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
        newCounts[room] = count;
        totalUsers += count;
      }
      
      this._userCounts = newCounts;
      
      for (const [username, data] of Object.entries(this._userIndex)) {
        if (data && data.isMulti) {
          this._onlineUsers.add(username);
        }
      }
      
      await this.ctx.storage.put({
        userCounts: this._userCounts,
        onlineUsers: Array.from(this._onlineUsers)
      });
      
      return { counts: newCounts, total: totalUsers };
    } catch(e) {
      return { counts: this._userCounts, total: this._onlineUsers.size };
    }
  }

  async _loadFromStorage() {
    try {
      if (Object.keys(this._roomsDataCache).length === 0 && 
          Object.keys(this._userIndex).length === 0) {
        const roomsData = await this.ctx.storage.get("roomsData") || {};
        const userIndex = await this.ctx.storage.get("userIndex") || {};
        const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
        const userCounts = await this.ctx.storage.get("userCounts") || {};
        const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
        
        this._roomsDataCache = roomsData;
        this._userIndex = userIndex;
        this.currentNumber = currentNumber;
        this._userCounts = userCounts;
        this._onlineUsers = new Set(onlineUsers);
        
        for (const [username, data] of Object.entries(this._userIndex)) {
          if (data && data.isMulti) {
            this._onlineUsers.add(username);
          }
        }
      }
      
      return {
        roomsData: this._roomsDataCache,
        userIndex: this._userIndex,
        currentNumber: this.currentNumber,
        userCounts: this._userCounts,
        onlineUsers: Array.from(this._onlineUsers)
      };
    } catch(e) {
      return { 
        roomsData: {}, 
        userIndex: {},
        currentNumber: 1,
        userCounts: {},
        onlineUsers: []
      };
    }
  }

  _isUsernameExists(username) {
    if (!username) return false;
    return this._onlineUsers.has(username) || 
           this._userIndex.hasOwnProperty(username);
  }

  // ============ REMOVE USER ============

  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    
    const userRooms = this._getUserRooms(username);
    
    if (this._isUserMulti(username)) {
      for (const [roomName, seat] of Object.entries(userRooms)) {
        const roomData = this._roomsDataCache[roomName];
        if (roomData && roomData.seats && roomData.seats[seat]) {
          delete roomData.seats[seat];
          if (roomData.points) {
            delete roomData.points[seat];
          }
          this.broadcast(roomName, ["removeKursi", roomName, seat]);
          await this.updateRoomCount(roomName);
          await this._deleteRoomIfEmpty(roomName);
        }
      }
      
      this._removeUserFromAllIndex(username);
      this._setUserMulti(username, true);
      this._onlineUsers.add(username);
      await this._syncAllData();
      return true;
    }
    
    let removed = false;
    
    for (const [roomName, seat] of Object.entries(userRooms)) {
      const roomData = this._roomsDataCache[roomName];
      if (roomData && roomData.seats && roomData.seats[seat]) {
        delete roomData.seats[seat];
        if (roomData.points) {
          delete roomData.points[seat];
        }
        removed = true;
        this.broadcast(roomName, ["removeKursi", roomName, seat]);
        await this.updateRoomCount(roomName);
        await this._deleteRoomIfEmpty(roomName);
      }
    }
    
    this._removeUserFromAllIndex(username);
    this._onlineUsers.delete(username);
    this.userSeat.delete(username);
    this.userRoom.delete(username);
    this.userConnections.delete(username);
    
    if (removed) {
      await this._syncAllData();
    }
    
    return removed;
  }

  // ============ CLEAN USER FROM SPECIFIC ROOM ============
  
  async _cleanUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    const seat = this._getUserSeat(username, roomName);
    if (seat === null) return false;
    
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    delete roomData.seats[seat];
    if (roomData.points) {
      delete roomData.points[seat];
    }
    
    this._removeUserFromIndex(username, roomName);
    
    if (!this._isUserMulti(username)) {
      this._onlineUsers.delete(username);
    }
    
    this.userSeat.delete(username);
    this.userRoom.delete(username);
    
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    await this._deleteRoomIfEmpty(roomName);
    await this._syncAllData();
    
    return true;
  }

  async _isUserInAnyRoom(username) {
    if (!username) return null;
    
    const userRooms = this._getUserRooms(username);
    const entries = Object.entries(userRooms);
    
    if (entries.length > 0) {
      const [roomName, seat] = entries[0];
      const isMulti = this._isUserMulti(username);
      return { room: roomName, seat: seat, isMulti: isMulti };
    }
    
    return null;
  }

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    const seat = this._getUserSeat(username, roomName);
    if (!seat) return false;
    
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    delete roomData.seats[seat];
    if (roomData.points) {
      delete roomData.points[seat];
    }
    
    this._removeUserFromIndex(username, roomName);
    
    if (this._isUserMulti(username)) {
      this._onlineUsers.add(username);
    } else {
      this._onlineUsers.delete(username);
    }
    
    await this._syncAllData();
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    await this._deleteRoomIfEmpty(roomName);
    
    return true;
  }

  async _updateKursi(roomName, seat, data) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    roomData.seats[seat] = {
      noimageUrl: data.noimageUrl || "",
      namauser: data.namauser || "",
      color: data.color || "",
      itembawah: data.itembawah || 0,
      itematas: data.itematas || 0,
      vip: data.vip || 0,
      viptanda: data.viptanda || 0
    };
    
    await this._syncAllData();
    return true;
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    if (!roomData.points) roomData.points = {};
    roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
    
    await this._syncAllData();
    return true;
  }

  async _deleteUserSeat(username) {
    if (this._isUserMulti(username)) {
      this._onlineUsers.add(username);
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      await this._saveMultiIdState();
      return;
    }
    
    this._removeUserFromAllIndex(username);
    this._onlineUsers.delete(username);
    await this._syncAllData();
  }

  async _deleteRoomIfEmpty(roomName) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData) return;
    
    const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
    const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
    
    if (!hasSeats && !hasPoints) {
      delete this._roomsDataCache[roomName];
      await this._syncAllData();
    }
  }

  async _cleanupPhantomUsers() {
    try {
      let cleaned = 0;
      
      const usersToRemove = [];
      
      for (const [username, data] of Object.entries(this._userIndex)) {
        if (!data || Object.keys(data.rooms).length === 0) {
          usersToRemove.push(username);
          continue;
        }
        
        let hasSeat = false;
        for (const [roomName, seat] of Object.entries(data.rooms)) {
          const roomData = this._roomsDataCache[roomName];
          if (roomData && roomData.seats && roomData.seats[seat]) {
            hasSeat = true;
            break;
          }
        }
        
        if (!hasSeat) {
          usersToRemove.push(username);
        }
      }
      
      for (const username of usersToRemove) {
        delete this._userIndex[username];
        this._onlineUsers.delete(username);
        this.userSeat.delete(username);
        this.userRoom.delete(username);
        this.userConnections.delete(username);
        cleaned++;
      }
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser) {
            const username = data.namauser;
            
            if (!this._userIndex[username]) {
              let isMulti = false;
              const webSockets = this._getActiveWebSockets();
              for (const ws of webSockets) {
                try {
                  const attachment = ws.deserializeAttachment();
                  if (attachment && attachment.username === username && attachment.isMulti) {
                    isMulti = true;
                    break;
                  }
                } catch(e) {}
              }
              
              this._addUserToIndex(username, roomName, parseInt(seat));
              if (isMulti) {
                this._setUserMulti(username, true);
                this._onlineUsers.add(username);
              }
              cleaned++;
            }
          }
        }
      }
      
      if (cleaned > 0) {
        await this._syncAllData();
      }
      
      return cleaned;
      
    } catch(e) {
      return 0;
    }
  }

  // ============ VALIDASI KONSISTENSI DATA ============

  async _validateDataConsistency() {
    let inconsistencies = 0;
    let fixed = 0;

    for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
      if (!roomData || !roomData.seats) continue;
      
      for (const [seatNum, seatData] of Object.entries(roomData.seats)) {
        if (!seatData || !seatData.namauser) continue;
        
        const username = seatData.namauser;
        const userRooms = this._getUserRooms(username);
        
        if (!userRooms[roomName] || userRooms[roomName] !== parseInt(seatNum)) {
          this._addUserToIndex(username, roomName, parseInt(seatNum));
          fixed++;
        }
      }
    }

    for (const [username, userData] of Object.entries(this._userIndex)) {
      if (!userData || !userData.rooms) continue;
      
      for (const [roomName, seat] of Object.entries(userData.rooms)) {
        const roomData = this._roomsDataCache[roomName];
        if (!roomData || !roomData.seats || !roomData.seats[seat]) {
          this._removeUserFromIndex(username, roomName);
          fixed++;
        } else if (roomData.seats[seat].namauser !== username) {
          roomData.seats[seat].namauser = username;
          fixed++;
        }
      }
    }

    for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
      if (!roomData || !roomData.seats) continue;
      
      const seenUsers = new Map();
      const toRemove = [];
      
      for (const [seatNum, seatData] of Object.entries(roomData.seats)) {
        if (seatData && seatData.namauser) {
          const username = seatData.namauser;
          if (seenUsers.has(username)) {
            toRemove.push(parseInt(seatNum));
            inconsistencies++;
          } else {
            seenUsers.set(username, parseInt(seatNum));
          }
        }
      }
      
      for (const seatNum of toRemove) {
        delete roomData.seats[seatNum];
        if (roomData.points) {
          delete roomData.points[seatNum];
        }
        fixed++;
        this.broadcast(roomName, ["removeKursi", roomName, seatNum]);
      }
    }

    const usersToRemove = [];
    for (const [username, data] of Object.entries(this._userIndex)) {
      if (!data || Object.keys(data.rooms).length === 0) {
        usersToRemove.push(username);
      }
    }
    
    for (const username of usersToRemove) {
      delete this._userIndex[username];
      this._onlineUsers.delete(username);
      fixed++;
    }

    if (fixed > 0) {
      await this._syncAllData();
    }

    return { inconsistencies: inconsistencies, fixed: fixed };
  }

  // ============ MULTI TRACKING HELPERS ============
  
  _updateUserConnection(username, ws) {
    if (!username || !ws) return;
    
    let connections = this.userConnections.get(username);
    if (!connections) {
      connections = new Set();
      this.userConnections.set(username, connections);
    }
    if (!connections.has(ws)) {
      connections.add(ws);
    }
  }

  // ============ JOIN HANDLING ============

  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    const isMulti = ws._isMulti || this._isUserMulti(username);
    const lockKey = `join_${roomName}_${username}`;
    
    if (this._joinLocks.has(lockKey)) {
      this.safeSend(ws, ["roomFull", roomName]);
      return false;
    }
    
    this._joinLocks.set(lockKey, Date.now());
    
    try {
      const existingSeat = this._getUserSeat(username, roomName);
      if (existingSeat !== null) {
        const roomData = this._roomsDataCache[roomName];
        if (roomData && roomData.seats && roomData.seats[existingSeat]) {
          const seatData = roomData.seats[existingSeat];
          if (seatData.namauser !== username) {
            seatData.namauser = username;
            await this._syncAllData();
          }
        }
        
        this.safeSend(ws, ["rooMasuk", existingSeat, roomName]);
        this.safeSend(ws, ["numberKursiSaya", existingSeat]);
        
        ws.serializeAttachment({
          username: username,
          room: roomName,
          seat: existingSeat,
          isMulti: isMulti
        });
        
        ws._cachedRoom = roomName;
        ws._cachedUsername = username;
        ws.room = roomName;
        ws.roomname = roomName;
        ws._multiSeat = existingSeat;
        
        this._updateUserConnection(username, ws);
        this.userSeat.set(username, { room: roomName, seat: existingSeat, isMulti: isMulti });
        this.userRoom.set(username, roomName);
        
        const roomClients = this.roomClients.get(roomName);
        if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
        
        await this._syncAllData();
        
        setTimeout(() => {
          try {
            if (ws && ws.readyState === 1) {
              this.sendAllStateTo(ws, roomName, true);
            }
          } catch(e) {}
        }, 1000);
        
        return true;
      }
      
      const userRooms = this._getUserRooms(username);
      for (const [roomNameLoop, seat] of Object.entries(userRooms)) {
        const roomData = this._roomsDataCache[roomNameLoop];
        if (roomData && roomData.seats && roomData.seats[seat]) {
          if (roomData.seats[seat].namauser === username) {
            delete roomData.seats[seat];
            if (roomData.points) {
              delete roomData.points[seat];
            }
            this.broadcast(roomNameLoop, ["removeKursi", roomNameLoop, seat]);
            await this.updateRoomCount(roomNameLoop);
            await this._deleteRoomIfEmpty(roomNameLoop);
          }
        }
      }
      
      this._removeUserFromAllIndex(username);
      this._onlineUsers.delete(username);
      
      if (isMulti) {
        this._setUserMulti(username, true);
      }
      
      await this._syncAllData();
      
      let roomData = this._roomsDataCache[roomName];
      if (!roomData) {
        roomData = { seats: {}, points: {}, muted: false, number: 1 };
        this._roomsDataCache[roomName] = roomData;
        await this._syncAllData();
      }
      
      const seatsToRemove = [];
      for (const [existingSeatNum, existingData] of Object.entries(roomData.seats)) {
        if (existingData && existingData.namauser === username) {
          seatsToRemove.push(parseInt(existingSeatNum));
        }
      }
      
      for (const seatNum of seatsToRemove) {
        delete roomData.seats[seatNum];
        if (roomData.points) {
          delete roomData.points[seatNum];
        }
        this.broadcast(roomName, ["removeKursi", roomName, seatNum]);
      }
      
      const seatCount = Object.keys(roomData.seats).length;
      if (seatCount >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      let seat = this._findAvailableSeat(roomData, username);
      if (!seat) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      if (roomData.seats[seat] && roomData.seats[seat].namauser) {
        const newSeat = this._findAvailableSeat(roomData, username);
        if (!newSeat) {
          this.safeSend(ws, ["roomFull", roomName]);
          return false;
        }
        seat = newSeat;
      }
      
      roomData.seats[seat] = {
        noimageUrl: "",
        namauser: username,
        color: "",
        itembawah: 0,
        itematas: 0,
        vip: 0,
        viptanda: 0
      };
      
      this._addUserToIndex(username, roomName, seat);
      this._setUserMulti(username, isMulti);
      this._onlineUsers.add(username);
      
      await this._syncAllData();
      
      ws.serializeAttachment({
        username: username,
        room: roomName,
        seat: seat,
        isMulti: isMulti
      });
      
      ws._cachedRoom = roomName;
      ws._cachedUsername = username;
      ws.username = username;
      ws.room = roomName;
      ws.roomname = roomName;
      ws.idtarget = username;
      ws._isMulti = isMulti;
      ws._multiRoom = isMulti ? roomName : null;
      ws._multiSeat = isMulti ? seat : null;
      
      this._updateUserConnection(username, ws);
      this.userSeat.set(username, { room: roomName, seat: seat, isMulti: isMulti });
      this.userRoom.set(username, roomName);
      
      const roomClients = this.roomClients.get(roomName);
      if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
      
      this._refreshRoomClients(true);
      
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
      
      const count = Object.keys(roomData.seats).length;
      this.safeSend(ws, ["roomUserCount", roomName, count]);
      this.broadcast(roomName, ["roomUserCount", roomName, count]);
      this.broadcast(roomName, ["kursiBatchUpdate", roomName, [[seat, roomData.seats[seat]]]]);
      
      await this._syncAllData();
      
      setTimeout(() => {
        try {
          if (ws && ws.readyState === 1) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      
      return true;
      
    } finally {
      this._joinLocks.delete(lockKey);
    }
  }

  // ============ CLEANUP ON DISCONNECT ============

  async _cleanupUserOnDisconnect(ws) {
    try {
      const username = ws.username || ws._cachedUsername;
      if (!username) return;
      
      const isMulti = ws._isMulti || this._isUserMulti(username);
      
      const activeData = this.wsActiveMulti.get(ws);
      if (activeData) {
        this.wsActiveMulti.delete(ws);
      }
      
      const connections = this.userConnections.get(username);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.userConnections.delete(username);
          
          if (!isMulti) {
            const userRooms = this._getUserRooms(username);
            for (const [roomNameLoop, seat] of Object.entries(userRooms)) {
              const roomData = this._roomsDataCache[roomNameLoop];
              if (roomData && roomData.seats && roomData.seats[seat]) {
                if (roomData.seats[seat].namauser === username) {
                  delete roomData.seats[seat];
                  if (roomData.points) {
                    delete roomData.points[seat];
                  }
                  this.broadcast(roomNameLoop, ["removeKursi", roomNameLoop, seat]);
                  await this.updateRoomCount(roomNameLoop);
                  await this._deleteRoomIfEmpty(roomNameLoop);
                }
              }
            }
            
            this._removeUserFromAllIndex(username);
            this._onlineUsers.delete(username);
            this.userSeat.delete(username);
            this.userRoom.delete(username);
            await this._syncAllData();
          }
        }
      } else if (!isMulti) {
        const userRooms = this._getUserRooms(username);
        for (const [roomNameLoop, seat] of Object.entries(userRooms)) {
          const roomData = this._roomsDataCache[roomNameLoop];
          if (roomData && roomData.seats && roomData.seats[seat]) {
            if (roomData.seats[seat].namauser === username) {
              delete roomData.seats[seat];
              if (roomData.points) {
                delete roomData.points[seat];
              }
              this.broadcast(roomNameLoop, ["removeKursi", roomNameLoop, seat]);
              await this.updateRoomCount(roomNameLoop);
              await this._deleteRoomIfEmpty(roomNameLoop);
            }
          }
        }
        
        this._removeUserFromAllIndex(username);
        this._onlineUsers.delete(username);
        this.userSeat.delete(username);
        this.userRoom.delete(username);
        await this._syncAllData();
      }
      
      ws._cachedRoom = null;
      ws._cachedUsername = null;
      ws.room = null;
      ws.roomname = null;
      ws._multiRoom = null;
      ws._multiSeat = null;
      ws._isMulti = false;
      
      ws.serializeAttachment({ 
        username: username,
        isMulti: false
      });
      
      this._refreshRoomClients(true);
      
    } catch(e) {}
  }

  // ============ BROADCAST ============

  _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed || !room) return;
    
    this._refreshRoomClients(false);
    
    const clients = this.roomClients.get(room);
    if (!clients || clients.size === 0) return;
    
    const clientArray = Array.from(clients);
    const toRemove = new Set();
    
    for (let i = 0; i < clientArray.length; i += C.BATCH_SIZE) {
      const batch = clientArray.slice(i, Math.min(i + C.BATCH_SIZE, clientArray.length));
      
      for (const ws of batch) {
        if (!ws) { toRemove.add(ws); continue; }
        
        try {
          const wsRoom = ws._cachedRoom || ws.room || ws.roomname;
          if (wsRoom !== room) {
            toRemove.add(ws);
            continue;
          }
          
          if (ws.readyState === 1 && !ws._closing) {
            ws.send(msgStr);
          } else {
            toRemove.add(ws);
          }
        } catch(e) { toRemove.add(ws); }
      }
    }
    
    if (toRemove.size > 0) {
      for (const ws of toRemove) {
        try { clients.delete(ws); } catch(e) {}
      }
    }
  }

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try { this._broadcastToRoom(room, JSON.stringify(msg)); } catch(e) {}
  }

  safeSend(ws, msg) {
    if (!ws) return false;
    try {
      if (ws.readyState !== 1 || ws._closing || this.closing || this.isDestroyed) {
        return false;
      }
      ws.send(JSON.stringify(msg));
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ ROOM COUNT ============

  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    try {
      const roomData = this._roomsDataCache[room];
      if (!roomData || !roomData.seats) return 0;
      const count = Object.keys(roomData.seats).length;
      
      this._userCounts[room] = count;
      await this.ctx.storage.put("userCounts", this._userCounts);
      
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { return 0; }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    
    const roomData = this._roomsDataCache[room];
    if (!roomData) return;
    
    try {
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userRooms = this._getUserRooms(ws.username);
      const selfSeat = userRooms[room] || null;
      
      const count = Object.keys(allSeats).length;
      this.safeSend(ws, ["roomUserCount", room, count]);
      
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
      
      if (allPoints && Object.keys(allPoints).length > 0) {
        let filteredPoints = Object.entries(allPoints).map(([seat, point]) => ({
          seat: parseInt(seat),
          x: point.x,
          y: point.y,
          fast: point.fast ? 1 : 0
        }));
        
        if (excludeSelf && selfSeat) {
          filteredPoints = filteredPoints.filter(p => p.seat !== selfSeat);
        }
        
        if (filteredPoints.length > 0) {
          this.safeSend(ws, ["allPointsList", room, filteredPoints]);
        }
      }
    } catch(e) {}
  }

  // ============ ALARM ============

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    await this._updateNumber();
    await this._checkMultiUsers();
    await this._cleanupStorage();
    await this._cleanupPhantomUsers();
    await this._validateDataConsistency();
    await this._syncAllData();
    
    if (!this.closing && !this.isDestroyed) {
      this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
    }
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      
      await this._saveToStorage(undefined, undefined, this.currentNumber);
      
      const storage = await this._loadFromStorage();
      const roomsData = storage.roomsData || {};
      let changed = false;
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (roomData) {
          roomData.number = this.currentNumber;
          changed = true;
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, undefined, undefined);
      }
      
      const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
      
      this._refreshRoomClients(true);
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          this._broadcastToRoom(room, numberMsg);
        }
      }
      
    } catch(e) {
      const storage = await this.ctx.storage.get(["currentNumber", "roomsData"]);
      if (storage.currentNumber !== undefined) this.currentNumber = storage.currentNumber;
      if (storage.roomsData !== undefined) this._roomsDataCache = storage.roomsData;
    } finally {
      this._isNumberUpdating = false;
    }
  }

  async _checkMultiUsers() {
    try {
      const webSockets = this._getActiveWebSockets();
      const connectedUsers = new Set();
      const usersWithSeats = new Set();
      
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname && ws.readyState === 1) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      
      for (const [username, data] of Object.entries(this._userIndex)) {
        if (data && Object.keys(data.rooms).length > 0) {
          usersWithSeats.add(username);
        }
      }
      
      let changed = false;
      
      for (const [username, data] of Object.entries(this._userIndex)) {
        if (data && data.isMulti) {
          this._onlineUsers.add(username);
          changed = true;
          
          const rooms = Object.keys(data.rooms);
          if (rooms.length === 0) {
            delete this._userIndex[username];
            this._onlineUsers.delete(username);
            changed = true;
          }
        }
      }
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, seatData] of Object.entries(roomData.seats)) {
          if (seatData && seatData.namauser) {
            const username = seatData.namauser;
            if (!this._userIndex[username]) {
              this._addUserToIndex(username, roomName, parseInt(seat));
              this._setUserMulti(username, true);
              this._onlineUsers.add(username);
              changed = true;
            } else if (!this._userIndex[username].rooms[roomName]) {
              this._addUserToIndex(username, roomName, parseInt(seat));
              changed = true;
            }
          }
        }
      }
      
      for (const [username, data] of Object.entries(this._userIndex)) {
        if (data && Object.keys(data.rooms).length > 0) {
          let hasSeat = false;
          for (const [roomName, seat] of Object.entries(data.rooms)) {
            const roomData = this._roomsDataCache[roomName];
            if (roomData && roomData.seats && roomData.seats[seat]) {
              hasSeat = true;
              break;
            }
          }
          if (!hasSeat) {
            delete this._userIndex[username];
            this._onlineUsers.delete(username);
            changed = true;
          }
        }
      }
      
      if (changed) {
        await this._syncAllData();
      }
      
    } catch(e) {}
  }

  async _cleanupStorage() {
    try {
      const storage = await this._loadFromStorage();
      const roomsData = storage.roomsData || {};
      const userIndex = storage.userIndex || {};
      
      let changed = false;
      
      const webSockets = this._getActiveWebSockets();
      const connectedUsers = new Set();
      
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname && ws.readyState === 1) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      
      for (const [username, data] of Object.entries(userIndex)) {
        if (!data || Object.keys(data.rooms).length === 0) {
          delete userIndex[username];
          changed = true;
          continue;
        }
        
        let hasSeat = false;
        for (const [roomName, seat] of Object.entries(data.rooms)) {
          const roomData = roomsData[roomName];
          if (roomData && roomData.seats && roomData.seats[seat]) {
            hasSeat = true;
            break;
          }
        }
        
        if (!hasSeat) {
          delete userIndex[username];
          changed = true;
        }
      }
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
        const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
        
        if (!hasSeats && !hasPoints) {
          delete roomsData[roomName];
          changed = true;
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, userIndex, storage.currentNumber);
        await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
        await this._saveMultiIdState();
      }
      
    } catch(e) {}
  }

  // ============ WEBSOCKET EVENTS ============

  async webSocketMessage(ws, message) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    
    try {
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {}
      
      if (attachment && attachment.username) {
        ws.username = attachment.username;
        ws.room = attachment.room;
        ws.roomname = attachment.room;
        ws.idtarget = attachment.username;
        ws._isMulti = attachment.isMulti || false;
        ws._multiRoom = attachment.multiRoom || null;
        ws._multiSeat = attachment.multiSeat || null;
        ws._cachedUsername = attachment.username;
        ws._cachedRoom = attachment.room;
        
        if (attachment.isMulti) {
          this._onlineUsers.add(attachment.username);
          this.userSeat.set(attachment.username, { 
            room: attachment.room || attachment.multiRoom, 
            seat: attachment.seat || attachment.multiSeat, 
            isMulti: true 
          });
        }
      }
      
      await this.handleMessage(ws, message);
    } catch(e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
    } catch(e) {}
  }

  async webSocketError(ws, error) {
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
    } catch(e) {}
  }

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    
    if (ws.readyState !== 1) return;
    
    const existingSeatInfo = this.userSeat.get(username);
    if (existingSeatInfo?.isMulti === true && isNewUser === false) {
      this._updateUserConnection(username, ws);
      
      ws.username = username;
      ws.idtarget = username;
      ws.room = null;
      ws.roomname = null;
      ws._closing = false;
      ws._isMulti = true;
      
      ws.serializeAttachment({ 
        username: username,
        isMulti: true
      });
      
      this.safeSend(ws, ["multiUserActive", username]);
      await this._syncAllData();
      return;
    }
    
    if (!this._isUserMulti(username)) {
      await this._removeUserFromAllRooms(username);
    }
    
    ws.username = username;
    ws.idtarget = username;
    ws.room = null;
    ws.roomname = null;
    ws._closing = false;
    ws._isMulti = false;
    ws._multiRoom = null;
    ws._multiSeat = null;
    ws._cachedUsername = username;
    ws._cachedRoom = null;
    
    ws.serializeAttachment({ username: username });
    
    this._updateUserConnection(username, ws);
    await this._syncAllData();
    
    if (isNewUser) { 
      this.safeSend(ws, ["joinroomawal"]); 
    } else { 
      this.safeSend(ws, ["needJoinRoom"]); 
    }
  }

  // ============ EVENT QUEUE ============
  
  _processEventQueue() {
    try {
      if (this._isProcessingQueue || this._eventQueue.length === 0) return;
      this._isProcessingQueue = true;
      
      const startTime = Date.now();
      let processed = 0;
      
      while (this._eventQueue.length > 0 && processed < 5) {
        if (Date.now() - startTime > C.MAX_PROCESS_TIME_MS) break;
        
        const item = this._eventQueue.shift();
        try {
          this._handleEventInternal(item.ws, item.data);
        } catch(e) {}
        processed++;
      }
      
      this._isProcessingQueue = false;
    } catch(e) {
      this._isProcessingQueue = false;
    }
  }

  async handleMessage(ws, raw) {
    if (!ws) return;
    try {
      if (ws.readyState !== 1 || ws._closing || this.closing || this.isDestroyed) {
        return;
      }
    } catch(e) { return; }
    
    if (this._processingMessages.has(ws)) return;
    this._processingMessages.add(ws);
    
    try {
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) return;
      
      let data;
      try { data = JSON.parse(str); } catch(e) { return; }
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      
      if (evt === "chat" || evt === "updatePoint" || evt === "gift" || evt === "rollangak") {
        const room = args[0];
        if (room && !ROOMS_SET.has(room)) return;
      }
      
      if (this._eventQueue.length < C.MAX_EVENT_QUEUE) {
        this._eventQueue.push({ ws, data: [evt, ...args] });
        if (!this._isProcessingQueue) {
          this._processEventQueue();
        }
      }
      
    } catch(e) {} finally {
      try {
        this._processingMessages.delete(ws);
      } catch(e) {}
    }
  }

  // ============ EVENT HANDLER (REST OF EVENTS SAME AS BEFORE) ============
  // ... (multiJoin, setActiveMulti, exitMulti, removeKursiAndPoint, etc.)
  // All events now call await this._syncAllData() after changes

  // ============ RESTORE STATE - REAL-TIME ============

  async _restoreAllState() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    try {
      // RESTORE MULTI ID STATE
      await this._restoreMultiIdState();
      
      // RESTORE ROOMS DATA
      const roomsData = await this.ctx.storage.get("roomsData") || {};
      const userIndex = await this.ctx.storage.get("userIndex") || {};
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      const userCounts = await this.ctx.storage.get("userCounts") || {};
      const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
      
      // RESTORE MUTE STATES
      const muteStates = await this.ctx.storage.get("muteStates") || {};
      
      // RESTORE NUMBER STATES
      const numberStates = await this.ctx.storage.get("numberStates") || {};
      
      // RESTORE POINTS
      const pointsData = await this.ctx.storage.get("pointsData") || {};
      
      const validatedUserIndex = {};
      const validatedRoomsData = {};
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (!roomData || !roomData.seats) continue;
        
        validatedRoomsData[roomName] = {
          seats: {},
          points: pointsData[roomName] || roomData.points || {},
          muted: muteStates[roomName] !== undefined ? muteStates[roomName] : (roomData.muted || false),
          number: numberStates[roomName] || roomData.number || 1
        };
        
        const seenUsers = new Set();
        
        for (const [seatNum, seatData] of Object.entries(roomData.seats)) {
          if (!seatData || !seatData.namauser) continue;
          
          const username = seatData.namauser;
          const seatNumInt = parseInt(seatNum);
          
          if (seenUsers.has(username)) {
            continue;
          }
          
          if (seatNumInt < 1 || seatNumInt > C.MAX_SEATS) {
            continue;
          }
          
          validatedRoomsData[roomName].seats[seatNum] = seatData;
          seenUsers.add(username);
          
          if (!validatedUserIndex[username]) {
            validatedUserIndex[username] = { rooms: {}, isMulti: false };
          }
          validatedUserIndex[username].rooms[roomName] = seatNumInt;
        }
      }
      
      for (const [username, userData] of Object.entries(userIndex)) {
        if (!userData || !userData.rooms) continue;
        
        for (const [roomName, seat] of Object.entries(userData.rooms)) {
          const roomData = validatedRoomsData[roomName];
          if (!roomData || !roomData.seats || !roomData.seats[seat]) {
            delete userData.rooms[roomName];
          } else if (roomData.seats[seat].namauser !== username) {
            delete userData.rooms[roomName];
          }
        }
        
        if (Object.keys(userData.rooms).length === 0) {
          delete validatedUserIndex[username];
        } else {
          if (!validatedUserIndex[username]) {
            validatedUserIndex[username] = { rooms: {}, isMulti: false };
          }
          validatedUserIndex[username].rooms = { ...userData.rooms };
          validatedUserIndex[username].isMulti = userData.isMulti || false;
        }
      }
      
      this._roomsDataCache = validatedRoomsData;
      this._userIndex = validatedUserIndex;
      this.currentNumber = currentNumber;
      this._userCounts = userCounts;
      
      if (onlineUsers) {
        for (const username of onlineUsers) {
          this._onlineUsers.add(username);
        }
      }
      
      await this._saveToStorage(validatedRoomsData, validatedUserIndex, currentNumber);
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      
      // RESTORE WEBSOCKET CONNECTIONS
      const webSockets = this.ctx.getWebSockets();
      
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            const username = attachment.username;
            const isMulti = attachment.isMulti || false;
            const room = attachment.room || attachment.multiRoom;
            const seat = attachment.seat || attachment.multiSeat;
            
            if (username) {
              let connections = this.userConnections.get(username);
              if (!connections) {
                connections = new Set();
                this.userConnections.set(username, connections);
              }
              if (!connections.has(ws)) {
                connections.add(ws);
              }
              
              ws.username = username;
              ws._cachedUsername = username;
              ws._isMulti = isMulti;
              
              if (isMulti && room && seat) {
                ws._multiRoom = room;
                ws._multiSeat = seat;
                ws._cachedRoom = room;
                ws.room = room;
                ws.roomname = room;
                ws.idtarget = username;
                
                this.wsActiveMulti.set(ws, { username, room });
                
                const roomClients = this.roomClients.get(room);
                if (roomClients && !roomClients.has(ws)) {
                  roomClients.add(ws);
                }
                
                if (!this.userSeat.has(username)) {
                  this.userSeat.set(username, { room, seat, isMulti: true });
                  this.userRoom.set(username, room);
                }
                
                this._onlineUsers.add(username);
              } else if (room && seat) {
                ws.room = room;
                ws.roomname = room;
                ws._cachedRoom = room;
                ws.idtarget = username;
                
                const roomClients = this.roomClients.get(room);
                if (roomClients && !roomClients.has(ws)) {
                  roomClients.add(ws);
                }
                
                if (!this.userSeat.has(username)) {
                  this.userSeat.set(username, { room, seat, isMulti: false });
                  this.userRoom.set(username, room);
                }
              }
            }
          }
        } catch(e) {}
      }
      
      await this._cleanupPhantomUsers();
      await this._validateDataConsistency();
      await this._syncAllData();
      
      this._refreshRoomClients(true);
      await this._updateUserCounts();
      
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      
    } catch(e) {
    } finally {
      this._isRestoring = false;
    }
  }

  // ============ RESET DATA ============

  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      this._roomsDataCache = {};
      this._userIndex = {};
      this.currentNumber = 1;
      this._onlineUsers.clear();
      this._userCounts = {};
      this.userSeat.clear();
      this.userRoom.clear();
      this.userConnections.clear();
      this.wsActiveMulti.clear();
      
      for (const room of ROOMS) {
        this._userCounts[room] = 0;
      }
      
      await this.ctx.storage.delete("roomsData");
      await this.ctx.storage.delete("userIndex");
      await this.ctx.storage.delete("currentNumber");
      await this.ctx.storage.delete("userCounts");
      await this.ctx.storage.delete("onlineUsers");
      await this.ctx.storage.delete("multiIdState");
      await this.ctx.storage.delete("muteStates");
      await this.ctx.storage.delete("numberStates");
      await this.ctx.storage.delete("pointsData");
      
      const resetMessage = JSON.stringify(["serverReset", "Server di-reset pada: " + new Date(timestamp).toLocaleString()]);
      
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(resetMessage);
          }
        } catch(e) {}
      }
      
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.close(1000, "Server reset - " + timestamp);
          }
        } catch(e) {}
      }
      
      this._refreshRoomClients(true);
      
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
      await this.ctx.storage.put("lastReset", timestamp);
      
      return {
        success: true,
        message: "Semua data berhasil direset",
        timestamp: timestamp,
        resetTime: new Date(timestamp).toLocaleString()
      };
      
    } catch(e) {
      return {
        success: false,
        error: e.message,
        timestamp: timestamp
      };
    }
  }

  // ============ FETCH ============

  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    try {
      const url = new URL(req.url);
      
      if (url.pathname === "/reset" && req.method === "POST") {
        const result = await this.resetAllData();
        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      if (url.pathname === "/cleanup-phantom" && req.method === "POST") {
        const cleaned = await this._cleanupPhantomUsers();
        return new Response(JSON.stringify({
          success: true,
          cleaned: cleaned,
          message: `${cleaned} phantom users cleaned`
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      if (url.pathname === "/validate" && req.method === "POST") {
        const result = await this._validateDataConsistency();
        return new Response(JSON.stringify({
          success: true,
          inconsistencies: result.inconsistencies,
          fixed: result.fixed
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      if (url.pathname === "/status") {
        const webSockets = this._getActiveWebSockets();
        const status = {
          activeConnections: webSockets.length,
          rooms: this._userCounts,
          totalUsers: this._onlineUsers.size,
          currentNumber: this.currentNumber,
          isClosing: this.closing,
          isDestroyed: this.isDestroyed,
          uptime: Date.now() - this._startTime,
          userIndexSize: Object.keys(this._userIndex).length,
          multiUsers: this.userSeat.size,
          lastAutoSave: new Date(this._lastAutoSave).toISOString()
        };
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server - No Ping/Pong", { 
          status: 200,
          headers: { "Cache-Control": "no-cache" }
        });
      }
      
      const currentConnections = this._getActiveWebSockets().length;
      if (currentConnections >= C.MAX_GLOBAL_CONNECTIONS) {
        return new Response("Server full", { status: 503 });
      }
      
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      
      try {
        this.ctx.acceptWebSocket(server);
      } catch(e) {
        return new Response("WebSocket acceptance failed", { status: 500 });
      }
      
      server.username = null;
      server.room = null;
      server.roomname = null;
      server.idtarget = null;
      server._closing = false;
      server._wsId = Date.now() + Math.random();
      server._isMulti = false;
      server._multiRoom = null;
      server._multiSeat = null;
      server._cachedUsername = null;
      server._cachedRoom = null;
      
      server.serializeAttachment({});
      
      this._refreshRoomClients(true);
      
      return new Response(null, { 
        status: 101, 
        webSocket: client
      });
      
    } catch(e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============ DESTROY ============

  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    this._joinLocks.clear();
    this._kursiLocks.clear();
    
    if (this._autoSaveInterval) {
      clearInterval(this._autoSaveInterval);
      this._autoSaveInterval = null;
    }
    
    await this._syncAllData();
    await this._cleanupStorage();
    
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify(["serverShutdown", "Server shutting down"])); } catch(e) {}
        try { ws.close(1000, "Shutdown"); } catch(e) {}
      }
    }
    
    this.wsActiveMulti.clear();
    this.userConnections.clear();
    this.userSeat.clear();
    this.userRoom.clear();
    this.roomClients.clear();
    this._onlineUsers.clear();
    
    try {
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
  }
}

export default ChatServer;
