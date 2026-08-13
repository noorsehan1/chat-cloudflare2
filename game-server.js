// ==================== GAME-SERVER-HEMAT-DURABLE-FINAL.JS ====================
// ✅ TANPA CPU CHECK
// ✅ SINGLE MASTER INTERVAL
// ✅ BROADCAST BUFFERING
// ✅ FULL CACHE
// ✅ THROTTLED NOTIFICATIONS
// ✅ GLOBAL GAME SCHEDULER
// ✅ OPTIMAL UNTUK DURABLE OBJECT
// ✅ PERBAIKAN WEEKLY RESET (TERLEWAT BERAPA JAM/HARI/MINGGU)
// ✅ TANPA CONSOLE.LOG UNTUK DEPLOY

const CONSTANTS = {
  MAX_LOWCARD_GAMES: 10,
  REGISTRATION_TIME_MS: 20000,
  DRAW_TIME_MS: 20000,
  EVALUATION_DELAY_MS: 2000,
  MAX_BOTS_PER_GAME: 4,
  MAX_BET: 100000,
  BOT_DRAW_MIN_SECONDS: 2,
  BOT_DRAW_MAX_SECONDS: 15,
  MAX_BOT_DRAWS_PER_ROUND: 4,
  EVALUATION_TIMEOUT_MS: 30000,
  MAX_PLAYERS_PER_GAME: 45,
  GAME_CLEANUP_DELAY_MS: 5000,
  STALE_GAME_TIMEOUT_MS: 600000,
  STUCK_DRAW_TIMEOUT_MS: 60000,
  STUCK_REGISTRATION_TIMEOUT_MS: 30000,
  MAX_WS_CLIENTS: 50,
  MAX_EVENT_QUEUE_SIZE: 1000,
  ERROR_RESET_INTERVAL_MS: 60000,
  LOWCARD_WINNER_KEY: 'lowcard_winner_',
  LOWCARD_RECORDING_KEY: 'lowcard_recording_status_',
  
  MAX_DICE_GAMES: 10,
  DICE_ANSWER_TIME_MS: 20000,
  DICE_TOTAL_TIME_MS: 20000,
  MAX_DICE_VALUE: 6,
  DICE_ROOM: "Quiz",
  DICE_POINT_KEY: 'dice_points',
  DICE_LAST_WEEK_WINNER: 'dice_last_week_winner',
  DICE_LAST_RESET_WEEK: 'dice_last_reset_week',
  
  DICE_AUTO_START_DELAY_MS: 3000,
  TIE_BREAKER_TIME_LIMIT: 20,
  TIE_BREAKER_COOLDOWN: 15000,
  
  MASTER_INTERVAL_MS: 100,
  BROADCAST_FLUSH_INTERVAL_MS: 50,
  DICE_TICK_INTERVAL_MS: 1000,
  CLEANUP_INTERVAL_MS: 60000,
  RESET_CHECK_INTERVAL_MS: 300000,
  NOTIFICATION_THROTTLE_MS: 2000,
  BROADCAST_MAX_BUFFER: 20,
  MAX_EVENTS_PER_TICK: 5,
  BROADCAST_BATCH_SIZE: 5,
  DICE_IMPORTANT_SECONDS: [20, 15, 10, 5, 3, 1],
};

const QUIZ_SCHEDULE = {
  SESSIONS: [
    { start: 1, end: 2 },
    { start: 14, end: 19 },
    { start: 22, end: 23 }
  ],
  TIMEZONE_OFFSET: 8,
};

const DICE_ROOM = "Quiz";

// ==================== BROADCAST BUFFER ====================
class BroadcastBuffer {
  constructor() {
    this.buffers = new Map();
    this.flushInterval = CONSTANTS.BROADCAST_FLUSH_INTERVAL_MS || 50;
    this.maxBuffer = CONSTANTS.BROADCAST_MAX_BUFFER || 20;
    this._onSend = null;
  }

  add(room, message) {
    if (!room || !message) return;
    
    if (!this.buffers.has(room)) {
      this.buffers.set(room, { messages: [], timer: null });
    }
    
    const buffer = this.buffers.get(room);
    buffer.messages.push(message);
    
    if (buffer.messages.length >= this.maxBuffer) {
      this._flushRoom(room);
      return;
    }
    
    if (buffer.timer === null) {
      buffer.timer = setTimeout(() => {
        this._flushRoom(room);
      }, this.flushInterval);
    }
  }

  _flushRoom(room) {
    const buffer = this.buffers.get(room);
    if (!buffer || buffer.messages.length === 0) return;
    
    const messages = buffer.messages;
    buffer.messages = [];
    
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    
    if (this._onSend) {
      this._onSend(room, messages);
    }
  }

  setOnSend(callback) {
    this._onSend = callback;
  }

  flushAll() {
    for (const [room] of this.buffers) {
      this._flushRoom(room);
    }
  }

  clear() {
    for (const [room, buffer] of this.buffers) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.buffers.clear();
  }
}

// ==================== DICE GAME SYSTEM ====================
class DiceGameSystem {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.env = gameServer.env;
    this._dicePointsCache = null;
    this._isCacheReady = false;
    this._isLoading = false;
  }

  async initCache() {
    if (this._isCacheReady) return true;
    if (this._isLoading) return false;
    
    this._isLoading = true;
    try {
      const points = await this.env.QUESTIONS.get(CONSTANTS.DICE_POINT_KEY, 'json') || {};
      this._dicePointsCache = points;
      this._isCacheReady = true;
      this._isLoading = false;
      return true;
    } catch(e) {
      this._isLoading = false;
      return false;
    }
  }

  async getPoints() {
    if (!this._isCacheReady) await this.initCache();
    return this._dicePointsCache || {};
  }

  async getUserPoint(username) {
    if (!this._isCacheReady) await this.initCache();
    return this._dicePointsCache?.[username] || 0;
  }

  async addPoints(username, pointsToAdd = 1) {
    try {
      if (!this.env?.QUESTIONS) return false;
      if (!this._isCacheReady) await this.initCache();
      
      const points = this._dicePointsCache || {};
      points[username] = (points[username] || 0) + pointsToAdd;
      
      await this.env.QUESTIONS.put(CONSTANTS.DICE_POINT_KEY, JSON.stringify(points));
      
      this._dicePointsCache = points;
      this.gameServer._broadcastToRoom(DICE_ROOM, ["dicePointsUpdated", points]);
      return true;
    } catch(e) {
      return false;
    }
  }

  async resetPoints() {
    try {
      if (!this.env?.QUESTIONS) return false;
      if (!this._isCacheReady) await this.initCache();
      
      const points = this._dicePointsCache || {};
      
      let winner = null, highestScore = 0;
      const validEntries = [];
      
      for (const [username, score] of Object.entries(points)) {
        const numericScore = typeof score === 'number' ? score : parseInt(score, 10) || 0;
        if (numericScore > 0) {
          validEntries.push({ username, score: numericScore });
          if (numericScore > highestScore) {
            highestScore = numericScore;
            winner = username;
          }
        }
      }
      
      if (winner && highestScore > 0) {
        const week = this._generateCurrentWeek(new Date());
        const winnerData = { 
          username: winner, 
          score: highestScore, 
          week, 
          timestamp: Date.now(),
          totalPlayers: validEntries.length
        };
        
        await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_WEEK_WINNER, JSON.stringify(winnerData));
        this.gameServer._lastWeekWinnerCache = winnerData;
        this.gameServer._isWinnerCacheReady = true;
      } else {
        this.gameServer._lastWeekWinnerCache = null;
        this.gameServer._isWinnerCacheReady = true;
        await this.env.QUESTIONS.delete(CONSTANTS.DICE_LAST_WEEK_WINNER).catch(() => {});
      }
      
      this._dicePointsCache = {};
      await this.env.QUESTIONS.put(CONSTANTS.DICE_POINT_KEY, JSON.stringify({}));
      
      this.gameServer._broadcastToRoom(DICE_ROOM, ["dicePointsReset", { 
        winner, 
        highestScore,
        week: this._generateCurrentWeek(new Date()),
        timestamp: Date.now()
      }]);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async getLastWeekWinner() {
    try {
      if (!this.env?.QUESTIONS) return null;
      if (this.gameServer._isWinnerCacheReady && this.gameServer._lastWeekWinnerCache !== undefined) {
        return this.gameServer._lastWeekWinnerCache;
      }
      
      const winnerData = await this.env.QUESTIONS.get(CONSTANTS.DICE_LAST_WEEK_WINNER, 'json');
      this.gameServer._lastWeekWinnerCache = winnerData;
      this.gameServer._isWinnerCacheReady = true;
      return winnerData;
    } catch(e) {
      return null;
    }
  }

  async deleteLastWeekWinner() {
    try {
      if (!this.env?.QUESTIONS) return false;
      this.gameServer._lastWeekWinnerCache = null;
      this.gameServer._isWinnerCacheReady = true;
      await this.env.QUESTIONS.delete(CONSTANTS.DICE_LAST_WEEK_WINNER);
      return true;
    } catch(e) {
      return false;
    }
  }

  clearCache() {
    this._dicePointsCache = null;
    this._isCacheReady = false;
    this._isLoading = false;
  }

  _generateCurrentWeek(date) {
    const now = date || new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const year = d.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((d - startOfYear) / 86400000) + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }
}

// ==================== GLOBAL GAME SCHEDULER ====================
class GameScheduler {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.games = gameServer.activeGames;
    this.interval = null;
    this._isProcessing = false;
    this.start();
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      if (this._isProcessing) return;
      this._isProcessing = true;
      try {
        for (const [room, game] of this.games) {
          if (!game || game._gameEnded || !game._isActive) continue;
          this._processGame(room, game);
        }
      } catch(e) {}
      finally {
        this._isProcessing = false;
      }
    }, 1000);
  }

  _processGame(room, game) {
    try {
      if (game.registrationOpen && game._registrationStartTime) {
        const elapsed = (Date.now() - game._registrationStartTime) / 1000;
        const timeLeft = Math.max(0, Math.floor((CONSTANTS.REGISTRATION_TIME_MS / 1000) - elapsed));
        if (timeLeft > 0 && timeLeft % 5 === 0) {
          this.gameServer._broadcastToRoom(room, ["gameLowCardTimeLeft", `${timeLeft}s`]);
        }
        if (timeLeft <= 0) {
          this.gameServer._closeRegistration(room, game);
        }
      }
      
      if (game._phase === 'draw' && game._drawPhaseStart) {
        const elapsed = (Date.now() - game._drawPhaseStart) / 1000;
        const timeLeft = Math.max(0, Math.floor((CONSTANTS.DRAW_TIME_MS / 1000) - elapsed));
        if (timeLeft > 0 && timeLeft % 5 === 0) {
          this.gameServer._broadcastToRoom(room, ["gameLowCardTimeLeft", `${timeLeft}s`]);
        }
        if (timeLeft <= 0 && !game.drawTimeExpired && !game.evaluationLocked) {
          this.gameServer._closeDrawPhase(room, game);
        }
      }
    } catch(e) {}
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ==================== ROOM MANAGER ====================
class RoomManager {
  constructor(name) {
    this.name = name;
    this.seats = new Map();
    this.points = new Map();
    this.muted = false;
    this.number = 1;
    this.lastActivity = Date.now();
  }

  getAvailableSeat() {
    for (let seat = 1; seat <= 45; seat++) {
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
    this.lastActivity = Date.now();
    return seat;
  }

  removeSeat(seat) {
    this.points.delete(seat);
    this.lastActivity = Date.now();
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
    this.lastActivity = Date.now();
    return this.muted; 
  }
  
  getMuted() { return this.muted; }
  
  setNumber(n) { this.number = n || 1; }
  getNumber() { return this.number; }

  updatePoint(seat, x, y, fast) {
    if (!this.seats.has(seat)) return false;
    this.points.set(seat, { x: x || 0, y: y || 0, fast: !!fast });
    this.lastActivity = Date.now();
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

  isInactive(timeout = 3600000) {
    return Date.now() - this.lastActivity > timeout && this.getCount() === 0;
  }
}

// ==================== GAME SERVER CLASS ====================
export class GameServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();

    this._rateLimitMap = new Map();
    
    this._eventQueue = [];
    this._isProcessingQueue = false;
    this._maxQueueSize = CONSTANTS.MAX_EVENT_QUEUE_SIZE;

    this._wsIdCounter = 0;
    this.wsClients = new Map();
    this.clientRooms = new Map();
    this.wsMap = new Map();
    this.userConnections = new Map();
    this._cleanupTimers = new Map();

    this.activeGames = new Map();
    this._maxGames = CONSTANTS.MAX_LOWCARD_GAMES;
    this._gameLocks = new Map();
    this._joinLocks = new Map();
    this._switchLocks = new Map();
    this._gameStartFlags = new Map();

    this.diceAnswered = new Set();
    this.diceHasWinner = false;
    this.diceWinner = null;
    this.currentDiceRoll = null;
    this._diceStartTime = null;
    this._diceTimeout = null;
    this._diceStartTimeout = null;
    this.diceAutoEnabled = false;
    this._isShowingDice = false;
    this._diceQuestionStartTime = null;
    this._canSubmitDiceAnswer = false;
    this._diceRound = 0;
    this._diceTimeUpCooldown = false;
    this._diceTimeUpCooldownTimer = null;
    this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
    this._lastNotificationKey = "";
    this._lastNotificationTime = 0;
    this._lastSentRemaining = -1;
    this.diceEndedToday = false;
    this.diceEndNotified = false;

    this._tieBreakers = new Map();
    this._tieRound = 0;
    this._tieActive = false;
    this._tiePlayers = [];
    this._tieAnswers = new Map();
    this._tieTimer = null;
    this._tieInterval = null;
    this._playerAnswers = new Map();
    this._processingTieResults = false;

    this._recordingCache = new Map();
    this._isRecordingCacheReady = false;
    this._lastWeekWinnerCache = null;
    this._isWinnerCacheReady = false;
    this._winnerCache = new Map();
    this._cachedResetWeek = null;
    this._lastResetCheck = Date.now();

    this.diceGameSystem = new DiceGameSystem(this);

    this._broadcastBuffer = new BroadcastBuffer();
    this._broadcastBuffer.setOnSend((room, messages) => {
      this._sendBatchToRoom(room, messages);
    });

    this._gameScheduler = new GameScheduler(this);

    this._lastDiceTick = Date.now();
    this._lastFlush = Date.now();
    this._lastCleanup = Date.now();
    this._lastDiceKeepAlive = Date.now();
    this._lastHeartbeat = Date.now();

    this._masterInterval = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this._masterInterval);
        this._masterInterval = null;
        return;
      }
      this._masterTick();
    }, CONSTANTS.MASTER_INTERVAL_MS || 100);

    setTimeout(async () => {
      try {
        if (!this.closing && !this.isDestroyed) {
          await this.diceGameSystem.initCache();
          await this._initRecordingCache();
          await this.diceGameSystem.getLastWeekWinner();
          await this._initResetWeek();
          await this._forceCheckResetOnStartup();
        }
      } catch(e) {}
    }, 1000);

    setTimeout(() => {
      if (!this.closing && !this.isDestroyed) {
        this.forceStartDice();
      }
    }, 5000);
  }

  // ==================== MASTER TICK ====================
  _masterTick() {
    const now = Date.now();
    
    if (now - this._lastDiceTick >= CONSTANTS.DICE_TICK_INTERVAL_MS) {
      this._diceTimerTick();
      this._lastDiceTick = now;
    }
    
    if (now - this._lastFlush >= CONSTANTS.BROADCAST_FLUSH_INTERVAL_MS) {
      this._broadcastBuffer.flushAll();
      this._lastFlush = now;
    }
    
    if (now - this._lastDiceKeepAlive >= 5000) {
      this._lastHeartbeat = now;
      this._lastDiceKeepAlive = now;
    }
    
    if (now - this._lastCleanup >= CONSTANTS.CLEANUP_INTERVAL_MS) {
      this._cleanupStaleGames();
      this._cleanupDeadConnections();
      this._lastCleanup = now;
    }
    
    if (now - this._lastResetCheck >= CONSTANTS.RESET_CHECK_INTERVAL_MS) {
      this._checkAndResetWeeklyDice();
      this._lastResetCheck = now;
    }
  }

  // ==================== BROADCAST ====================
  
  _sendBatchToRoom(room, messages) {
    if (this.closing || this.isDestroyed || !room || !messages || messages.length === 0) return;
    
    const wsIds = this.wsClients.get(room);
    if (!wsIds?.size) return;
    
    const combinedMsg = messages.length === 1 
      ? JSON.stringify(messages[0])
      : JSON.stringify({ type: 'batch', messages });
    
    const wsIdArray = Array.from(wsIds);
    const BATCH_SIZE = CONSTANTS.BROADCAST_BATCH_SIZE || 5;
    
    for (let i = 0; i < wsIdArray.length; i += BATCH_SIZE) {
      const batch = wsIdArray.slice(i, i + BATCH_SIZE);
      for (const wsId of batch) {
        const ws = this.wsMap.get(wsId);
        if (ws && ws.readyState === 1) {
          try { ws.send(combinedMsg); } catch(e) {}
        }
      }
    }
  }

  _broadcastToRoom(room, message) {
    if (this.closing || this.isDestroyed || !room || !message) return;
    this._broadcastBuffer.add(room, message);
  }

  _safeSend(ws, message) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) { return false; }
  }

  // ==================== RATE LIMITING ====================
  _isRateLimited(wsId, eventType) {
    try {
      const now = Date.now();
      const key = `${wsId}_${eventType}`;
      const data = this._rateLimitMap.get(key);
      
      if (!data) {
        this._rateLimitMap.set(key, { count: 1, resetTime: now + 1000 });
        return false;
      }
      
      if (now > data.resetTime) {
        data.count = 1;
        data.resetTime = now + 1000;
        return false;
      }
      
      data.count++;
      return data.count > 10;
    } catch(e) {
      return false;
    }
  }

  // ==================== EVENT HANDLING ====================
  
  async handleEvent(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data?.[0]) return;
      
      const wsId = ws._wsId;
      const evt = data[0];
      
      if (wsId && this._isRateLimited(wsId, evt)) {
        this._safeSend(ws, ["gameLowCardError", "Too many requests"]);
        return;
      }
      
      this._eventQueue.push({ ws, data });
      
      if (!this._isProcessingQueue) {
        await this._processEventQueue();
      }
    } catch(e) {}
  }

  async _processEventQueue() {
    try {
      if (this._isProcessingQueue || this._eventQueue.length === 0) return;
      
      if (this._eventQueue.length > this._maxQueueSize) {
        this._eventQueue.splice(0, this._eventQueue.length - this._maxQueueSize);
      }
      
      this._isProcessingQueue = true;
      
      const batchSize = CONSTANTS.MAX_EVENTS_PER_TICK || 5;
      const batch = this._eventQueue.splice(0, batchSize);
      
      for (const item of batch) {
        try {
          await this._processEventItem(item.ws, item.data);
        } catch(e) {}
      }
      
      if (this._eventQueue.length > 0) {
        queueMicrotask(() => {
          if (!this.closing && !this.isDestroyed) {
            this._processEventQueue();
          }
        });
      }
      
    } catch(e) {
      this._isProcessingQueue = false;
    } finally {
      this._isProcessingQueue = false;
    }
  }

  async _processEventItem(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      await this._handleEventInternal(ws, data);
    } catch(e) {}
  }

  async _handleEventInternal(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      const evt = data[0];

      if (evt === "switchRoom") {
        const [_, room, username] = data;
        await this._switchRoom(ws, room, username);
        return;
      }

      if (evt === "submitDiceAnswer") {
        const [_, username, guess] = data;
        await this.submitDiceAnswer(ws, username, guess);
        return;
      }

      if (evt === "getDiceLastWeekWinner") {
        try {
          const winner = await this.diceGameSystem.getLastWeekWinner();
          if (winner && winner.username) {
            this._safeSend(ws, ["diceLastWeekWinner", winner.username, winner.score || 0, winner.week || ""]);
          } else {
            this._safeSend(ws, ["diceLastWeekWinner", "", 0, ""]);
          }
        } catch(e) {
          this._safeSend(ws, ["diceLastWeekWinner", "", 0, ""]);
        }
        return;
      }

      if (evt === "getDiceLeaderboard") {
        try {
          let limit = data.length > 1 && typeof data[1] === 'number' ? Math.min(data[1], 30) : 10;
          const points = await this.diceGameSystem.getPoints();
          const sorted = Object.entries(points)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
          const result = sorted.map(([username, score]) => `${username}|${score}`);
          this._safeSend(ws, ["diceLeaderboard", result]);
        } catch(e) {
          this._safeSend(ws, ["diceLeaderboard", []]);
        }
        return;
      }

      if (evt === "deleteDiceLastWeekWinner") {
        try {
          const success = await this.diceGameSystem.deleteLastWeekWinner();
          this._safeSend(ws, ["diceLastWeekWinnerDeleted", success, success ? "Deleted" : "Failed"]);
        } catch(e) {
          this._safeSend(ws, ["diceLastWeekWinnerDeleted", false, e.message]);
        }
        return;
      }

      if (evt === "getDiceNotification") {
        const remaining = this._getDiceQuestionRemainingTime();
        const timeLeft = this._getTimeLeftUntilNextDice();
        this._safeSend(ws, ["diceNotification", {
          type: "diceError",
          timestamp: Date.now(),
          diceValue: this.currentDiceRoll?.value || null,
          remaining: remaining,
          data: {
            isDiceTime: this._isDiceTime(),
            isActive: !!this.currentDiceRoll,
            hasWinner: this.diceHasWinner,
            winner: this.diceWinner,
            timeLeft: timeLeft.text,
            canSubmit: this._canSubmitDiceAnswer,
            round: this._diceRound || 1
          }
        }]);
        return;
      }

      if (evt === "getDiceStatus") {
        this._safeSend(ws, ["diceStatus", !!this.currentDiceRoll && this._canSubmitDiceAnswer, this._diceRound || 1]);
        return;
      }

      if (evt === "startRecordingWinners") {
        const roomName = data[1];
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const success = await this._startRecordingWinners(roomName);
        this._safeSend(ws, ["startRecordingResult", { success, message: success ? "Recording enabled" : "Failed" }]);
        return;
      }

      if (evt === "stopRecordingWinners") {
        const roomName = data[1];
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const success = await this._stopRecordingWinners(roomName);
        this._safeSend(ws, ["stopRecordingResult", { success, message: success ? "Recording stopped" : "Failed" }]);
        return;
      }

      if (evt === "getRecordingStatus") {
        const roomName = data[1];
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const isRecordingEnabled = await this._getRecordingStatusFromKV(roomName);
        this._safeSend(ws, ["recordingStatus", isRecordingEnabled]);
        return;
      }

      if (evt === "getRoomWinners") {
        const room = data[1] || ws.room || this.clientRooms.get(ws._wsId);
        if (!room) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const isRecordingEnabled = await this._getRecordingStatusFromKV(room);
        const winners = await this._getLowCardWinners(room);
        this._broadcastToRoom(room, ["lowCardWinnerUpdate", { winners, room, recording: isRecordingEnabled }]);
        this._safeSend(ws, ["sendWinnersResult", { success: true, message: "Winners updated to room" }]);
        return;
      }

      if (evt === "sendWinnersToRoom") {
        const room = data[1];
        if (!room) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        await this._sendWinnersToRoom(room);
        this._safeSend(ws, ["sendWinnersResult", { success: true, message: "Winners data sent to room" }]);
        return;
      }

      if (evt === "getGameState") {
        const room = data[1] || ws.room || this.clientRooms.get(ws._wsId);
        if (room) {
          this._sendGameStateToClient(ws, room);
        }
        return;
      }

      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }

      switch (evt) {
        case "gameLowCardStart":
          await this._startGame(ws, data[1], data[2]);
          break;
        case "gameLowCardJoin":
          await this._joinGame(ws, data[1]);
          break;
        case "gameLowCardNumber":
          await this._submitNumber(ws, data[1], data[2] || "", data[3]);
          break;
        case "gameLowCardLeave":
          await this._leaveGame(ws, data[1]);
          break;
        case "checkGameRunning":
          await this._checkGameRunning(ws, data[1]);
          break;
        default:
          break;
      }
      
    } catch(e) {}
  }

  // ==================== CACHE METHODS ====================

  async _initRecordingCache() {
    if (this._isRecordingCacheReady) return;
    try {
      if (this.env?.QUESTIONS) {
        const list = await this.env.QUESTIONS.list({ prefix: CONSTANTS.LOWCARD_RECORDING_KEY });
        for (const key of list.keys) {
          const roomName = key.name.replace(CONSTANTS.LOWCARD_RECORDING_KEY, '');
          const value = await this.env.QUESTIONS.get(key.name);
          this._recordingCache.set(roomName, value === 'true');
        }
      }
      this._isRecordingCacheReady = true;
    } catch(e) {
      this._isRecordingCacheReady = true;
    }
  }

  async _initResetWeek() {
    try {
      if (!this.env?.QUESTIONS || this._cachedResetWeek) return;
      const existing = await this.env.QUESTIONS.get(CONSTANTS.DICE_LAST_RESET_WEEK);
      const currentWeek = this.diceGameSystem._generateCurrentWeek(new Date());
      if (!existing) {
        await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_RESET_WEEK, currentWeek);
        this._cachedResetWeek = currentWeek;
      } else {
        this._cachedResetWeek = existing;
      }
    } catch(e) {}
  }

  async _forceCheckResetOnStartup() {
    try {
      if (!this.env?.QUESTIONS) return;
      const currentWeek = this.diceGameSystem._generateCurrentWeek(new Date());
      if (this._cachedResetWeek && this._cachedResetWeek !== currentWeek) {
        await this._checkAndResetWeeklyDice();
      }
    } catch(e) {}
  }

  // ==================== FIX: WEEKLY RESET ====================
  async _checkAndResetWeeklyDice() {
    try {
      if (!this.env?.QUESTIONS) return false;
      
      const now = new Date();
      const currentWeek = this.diceGameSystem._generateCurrentWeek(now);
      
      if (this._cachedResetWeek === currentWeek) return false;
      
      const dayOfWeek = now.getUTCDay();
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      
      const isPastMondayReset = (dayOfWeek === 1 && (hours > 0 || minutes >= 0)) ||
                                (dayOfWeek > 1);
      
      const needReset = isPastMondayReset || 
                        (this._cachedResetWeek && this._cachedResetWeek !== currentWeek);
      
      if (needReset) {
        await this.diceGameSystem.resetPoints();
        this._cachedResetWeek = currentWeek;
        await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_RESET_WEEK, currentWeek);
        return true;
      }
      
      return false;
    } catch(e) {
      return false;
    }
  }

  async _getRecordingStatusFromKV(roomName) {
    if (!roomName) return false;
    if (!this._isRecordingCacheReady) await this._initRecordingCache();
    return this._recordingCache.get(roomName) || false;
  }

  async _startRecordingWinners(roomName) {
    try {
      if (!roomName) return false;
      if (!this._isRecordingCacheReady) await this._initRecordingCache();
      
      this._recordingCache.set(roomName, true);
      if (this.env?.QUESTIONS) {
        await this.env.QUESTIONS.put(CONSTANTS.LOWCARD_RECORDING_KEY + roomName, 'true');
      }
      this._broadcastToRoom(roomName, ["recordingStatus", true]);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _stopRecordingWinners(roomName) {
    try {
      if (!roomName) return false;
      const room = roomName.trim();
      
      this._recordingCache.delete(room);
      this._winnerCache.delete(room);
      
      if (this.env?.QUESTIONS) {
        await this.env.QUESTIONS.delete(CONSTANTS.LOWCARD_RECORDING_KEY + room);
        await this.env.QUESTIONS.delete(CONSTANTS.LOWCARD_WINNER_KEY + room);
      }
      this._broadcastToRoom(room, ["recordingStatus", false]);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _getLowCardWinners(room) {
    try {
      if (!room || !this.env?.QUESTIONS) return {};
      const isRecording = await this._getRecordingStatusFromKV(room);
      if (!isRecording) return {};
      
      if (this._winnerCache.has(room)) return this._winnerCache.get(room);
      
      const key = CONSTANTS.LOWCARD_WINNER_KEY + room;
      const winners = await this.env.QUESTIONS.get(key, 'json');
      if (winners && typeof winners === 'object' && Object.keys(winners).length > 0) {
        this._winnerCache.set(room, winners);
        return winners;
      }
      return {};
    } catch(e) {
      return {};
    }
  }

  async _addLowCardWinner(room, username) {
    try {
      if (!room || !username || room === DICE_ROOM) return false;
      if (!this.env?.QUESTIONS) return false;
      
      const isRecording = await this._getRecordingStatusFromKV(room);
      if (!isRecording) return false;
      
      const key = CONSTANTS.LOWCARD_WINNER_KEY + room;
      let roomWinners = this._winnerCache.get(room) || {};
      
      let currentCount = 0;
      if (roomWinners[username]) {
        currentCount = parseInt(String(roomWinners[username]).replace(/[xX]/g, '')) || 0;
      }
      roomWinners[username] = (currentCount + 1) + "x";
      
      this._winnerCache.set(room, roomWinners);
      await this.env.QUESTIONS.put(key, JSON.stringify(roomWinners));
      return true;
    } catch(e) {
      return false;
    }
  }

  // ==================== DICE METHODS ====================
  
  _isDiceTime() {
    try {
      const witaTime = this._getCurrentWITATime();
      const currentTotal = witaTime.totalMinutes;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        if (currentTotal >= session.start * 60 && currentTotal < session.end * 60) {
          return true;
        }
      }
      return false;
    } catch(e) { return false; }
  }

  _getCurrentWITATime() {
    try {
      const now = new Date();
      const hours = (now.getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
      const minutes = now.getUTCMinutes();
      return { hours, minutes, totalMinutes: (hours * 60) + minutes };
    } catch(e) {
      return { hours: 0, minutes: 0, totalMinutes: 0 };
    }
  }

  _getTimeLeftUntilNextDice() {
    try {
      const currentTotal = this._getCurrentWITATime().totalMinutes;
      let minDiff = Infinity;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        let diff = session.start * 60 - currentTotal;
        if (diff < 0) diff += 24 * 60;
        if (diff < minDiff) minDiff = diff;
      }
      const hours = Math.floor(minDiff / 60);
      const minutes = Math.floor(minDiff % 60);
      return { hours, minutes, text: `${hours}h ${minutes}m`, isRunning: this._isDiceTime() };
    } catch(e) {
      return { hours: 0, minutes: 0, text: '0h 0m', isRunning: false };
    }
  }

  forceStartDice() {
    try {
      if (this._tieActive || this._isShowingDice || this._diceTimeUpCooldown) return false;
      if (!this._isDiceTime() || this.currentDiceRoll || this._diceTimeout || this._diceStartTimeout) return false;
      this.diceAutoEnabled = true;
      this._showDiceQuestion();
      return true;
    } catch(e) { return false; }
  }

  async _showDiceQuestion() {
    try {
      if (this._tieActive || this._isShowingDice || this._diceTimeUpCooldown) return;
      if (!this._isDiceTime() || this.isDestroyed || this._diceStartTimeout || this.currentDiceRoll) return;
      
      this._isShowingDice = true;
      this._diceRound = (this._diceRound || 0) + 1;
      const diceValue = this.diceGameSystem.rollDice();
      
      this.currentDiceRoll = { value: diceValue, timestamp: Date.now(), round: this._diceRound };
      this._diceStartTime = Date.now();
      this._diceQuestionStartTime = Date.now();
      this._canSubmitDiceAnswer = true;
      this.diceAnswered = new Set();
      this.diceHasWinner = false;
      this.diceWinner = null;
      
      await this._broadcastDiceRoll(diceValue);
      
      this._broadcastDiceNotification("diceError", {
        answerTime: CONSTANTS.DICE_ANSWER_TIME_MS / 1000,
        remaining: 20,
        message: "♡ clik draw ♡",
        round: this._diceRound
      });
      
      this._startDiceTimerNotifications();
      
      if (this._diceTimeout) clearTimeout(this._diceTimeout);
      
      this._diceTimeout = setTimeout(async () => {
        try {
          if (this.closing || this.isDestroyed) {
            this._diceTimeout = null;
            this._isShowingDice = false;
            this._canSubmitDiceAnswer = false;
            return;
          }
          
          const currentClients = this.wsClients.get(DICE_ROOM);
          if (!currentClients?.size) {
            this._diceTimeout = null;
            this.currentDiceRoll = null;
            this._isShowingDice = false;
            this._canSubmitDiceAnswer = false;
            return;
          }
          
          const diceValue = this.currentDiceRoll?.value;
          const roundNumber = this._diceRound || 1;
          
          if (this.diceHasWinner && this.diceWinner) {
            const correctPlayers = [];
            for (const player of this.diceAnswered) {
              if (this._playerAnswers.get(player) === this.currentDiceRoll?.value) {
                correctPlayers.push(player);
              }
            }
            
            if (correctPlayers.length > 1 && !this._tieActive) {
              this._diceTimeout = null;
              this.currentDiceRoll = null;
              this._isShowingDice = false;
              this._canSubmitDiceAnswer = false;
              await this._startTieBreaker(DICE_ROOM, correctPlayers);
              return;
            }
            
            const points = await this.diceGameSystem.getPoints();
            this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
              username: this.diceWinner,
              totalPoints: points[this.diceWinner] || 0,
              diceValue: diceValue,
              round: roundNumber
            }]);
          } else {
            this._broadcastToRoom(DICE_ROOM, ["diceNoWinner", {
              message: `No winner`,
              value: diceValue,
              round: roundNumber
            }]);
          }
          
          this._diceTimeout = null;
          this.currentDiceRoll = null;
          this._isShowingDice = false;
          this._canSubmitDiceAnswer = false;
          this._startTimeUpCooldown();
          
        } catch(e) {}
      }, CONSTANTS.DICE_TOTAL_TIME_MS);
      
    } catch(e) {
      this._isShowingDice = false;
      this.currentDiceRoll = null;
      this._canSubmitDiceAnswer = false;
    }
  }

  _diceTimerTick() {
    try {
      if (!this.currentDiceRoll || !this._diceQuestionStartTime) return;
      
      const elapsed = (Date.now() - this._diceQuestionStartTime) / 1000;
      const remaining = Math.max(0, CONSTANTS.DICE_ANSWER_TIME_MS / 1000 - elapsed);
      const remainingInt = Math.floor(remaining);
      
      const importantSeconds = CONSTANTS.DICE_IMPORTANT_SECONDS;
      if (!importantSeconds.includes(remainingInt)) return;
      
      const now = Date.now();
      if (now - this._lastNotificationTime < CONSTANTS.NOTIFICATION_THROTTLE_MS) return;
      
      const flagKey = remainingInt;
      if (this._diceNotifiedFlags[flagKey]) return;
      
      this._diceNotifiedFlags[flagKey] = true;
      this._lastNotificationTime = now;
      
      const messages = {
        20: "20s remaining",
        15: "15s remaining",
        10: "10s remaining",
        5: "5s remaining",
        3: "3s remaining",
        1: "1s remaining"
      };
      
      if (messages[remainingInt]) {
        this._broadcastDiceNotification("diceError", {
          remaining: remainingInt,
          message: messages[remainingInt],
          round: this._diceRound || 1,
          isDiceTime: true,
          isActive: true
        });
      }
      
      if (remainingInt <= 0) {
        this._diceNotifiedFlags.timeup = true;
      }
    } catch(e) {}
  }

  _startDiceTimerNotifications() {
    this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
    this._lastNotificationTime = 0;
    this._lastSentRemaining = -1;
  }

  _broadcastDiceNotification(type, data) {
    try {
      if (this._tieActive && !data?.isTieBreaker) return;
      
      const wsIds = this.wsClients.get(DICE_ROOM);
      if (!wsIds?.size) return;
      
      const now = Date.now();
      const message = data.message || "";
      const remaining = data.remaining !== undefined ? data.remaining : -1;
      
      let key = `dice_${remaining}`;
      if (message === "TIME UP") key = "dice_timeup";
      if (data.cooldown) key = `cooldown_${remaining}`;
      
      if (message !== "TIME UP") {
        if (this._lastNotificationKey === key && (now - this._lastNotificationTime) < CONSTANTS.NOTIFICATION_THROTTLE_MS) return;
        if (remaining > 0 && this._lastSentRemaining === remaining && !data.cooldown) return;
      }
      
      this._lastNotificationKey = key;
      this._lastNotificationTime = now;
      if (remaining > 0) this._lastSentRemaining = remaining;
      
      this._broadcastToRoom(DICE_ROOM, ["diceNotification", message]);
    } catch(e) {}
  }

  async _broadcastDiceRoll(diceValue) {
    try {
      if (this._tieActive) return;
      const wsIds = this.wsClients.get(DICE_ROOM);
      if (!wsIds?.size) return;

      const msgStr = JSON.stringify(["diceRoll", {
        value: diceValue,
        timestamp: Date.now(),
        answerTime: CONSTANTS.DICE_ANSWER_TIME_MS / 1000,
        canAnswerNow: true,
        message: "♡ clik draw ♡",
        round: this._diceRound || 1
      }]);
      
      const wsIdArray = Array.from(wsIds);
      const BATCH_SIZE = CONSTANTS.BROADCAST_BATCH_SIZE || 5;
      
      for (let i = 0; i < wsIdArray.length; i += BATCH_SIZE) {
        const batch = wsIdArray.slice(i, i + BATCH_SIZE);
        for (const wsId of batch) {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1) {
            try { ws.send(msgStr); } catch(e) {}
          }
        }
      }
    } catch(e) {}
  }

  _getDiceQuestionRemainingTime() {
    try {
      if (!this.currentDiceRoll || !this._diceStartTime) return 0;
      const elapsed = (Date.now() - this._diceStartTime) / 1000;
      return Math.max(0, Math.round((CONSTANTS.DICE_TOTAL_TIME_MS / 1000) - elapsed));
    } catch(e) { return 0; }
  }

  _startTimeUpCooldown() {
    if (this._diceTimeUpCooldown) return;
    this._diceTimeUpCooldown = true;
    
    this._broadcastDiceNotification("diceError", {
      message: "wait 15s",
      remaining: 15,
      cooldown: true
    });
    
    this._diceTimeUpCooldownTimer = setTimeout(() => {
      this._diceTimeUpCooldownTimer = null;
      this._diceTimeUpCooldown = false;
      this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
      this._lastSentRemaining = -1;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      this._showDiceQuestion();
    }, 15000);
  }

  // ==================== SUBMIT DICE ANSWER ====================
  
  async submitDiceAnswer(ws, username, guess) {
    try {
      if (!ws || !username) return;
      
      if (this._tieActive) {
        if (!this._tiePlayers.includes(username) || this._tieAnswers.has(username) || !this._canSubmitDiceAnswer) return;
        
        this._tieAnswers.set(username, guess);
        this.diceAnswered.add(username);
        this._broadcastToRoom(DICE_ROOM, ["diceAnswer", {
          username, guess, round: this._diceRound || 1,
          isTieBreaker: true, tieRound: this._tieRound
        }]);
        
        if (this._tieAnswers.size === this._tiePlayers.length) {
          this._canSubmitDiceAnswer = false;
          this._isShowingDice = false;
          await this._processTieResults(DICE_ROOM, null, this._tiePlayers);
        }
        return;
      }
      
      if (this.diceAnswered.has(username) || !this._canSubmitDiceAnswer) return;
      
      const guessValue = parseInt(guess, 10);
      if (isNaN(guessValue) || guessValue < 1 || guessValue > 6) {
        this._safeSend(ws, ["diceError", "invalid guess 1-6"]);
        return;
      }
      
      const isCorrect = guessValue === this.currentDiceRoll?.value;
      this._playerAnswers.set(username, guessValue);
      this.diceAnswered.add(username);
      
      this._broadcastToRoom(DICE_ROOM, ["diceAnswer", {
        username, guess: guessValue, round: this._diceRound || 1
      }]);
      
      if (isCorrect && !this.diceHasWinner) {
        this.diceHasWinner = true;
        this.diceWinner = username;
        await this.diceGameSystem.addPoints(username, 1);
      }
    } catch(e) {}
  }

  // ==================== TIE BREAKER ====================
  
  async _startTieBreaker(room, players) {
    if (!players || players.length < 2 || this._tieActive) return;
    
    this._tieActive = true;
    this._tieRound = 0;
    this._tiePlayers = [...players];
    this._tieAnswers = new Map();
    
    const id = `tie_${Date.now()}`;
    this._tieBreakers.set(id, { players, round: 0, winner: null, status: 'waiting' });
    await this._runTieRound(room, id, players);
  }

  async _runTieRound(room, id, players) {
    const data = this._tieBreakers.get(id);
    if (!data) return;
    
    this._tieRound++;
    this._tiePlayers = [...players];
    this._tieAnswers = new Map();
    data.round = this._tieRound;
    data.status = 'running';
    data.players = players;
    this._canSubmitDiceAnswer = true;
    this._diceQuestionStartTime = Date.now();
    this.diceAnswered = new Set();
    this._isShowingDice = true;
    
    this._broadcastToRoom(DICE_ROOM, ["diceNotification", `♡ Round ${this._tieRound}: ${players.join(', ')}`]);
    this._startTieTimer(room, id, players);
  }

  _startTieTimer(room, id, players) {
    if (this._tieTimer) clearTimeout(this._tieTimer);
    if (this._tieInterval) clearInterval(this._tieInterval);
    
    let timeLeft = CONSTANTS.TIE_BREAKER_TIME_LIMIT || 20;
    let isProcessed = false;
    
    this._tieInterval = setInterval(() => {
      timeLeft--;
      if ([10, 5, 3].includes(timeLeft)) {
        this._broadcastToRoom(DICE_ROOM, ["diceNotification", `${timeLeft}s remaining`]);
      }
      if (timeLeft <= 0 && !isProcessed) {
        isProcessed = true;
        clearInterval(this._tieInterval);
        this._tieInterval = null;
        this._canSubmitDiceAnswer = false;
        this._isShowingDice = false;
        this._processTieResults(room, id, players);
      }
    }, 1000);
    
    this._tieTimer = setTimeout(() => {
      if (!isProcessed) {
        isProcessed = true;
        if (this._tieInterval) {
          clearInterval(this._tieInterval);
          this._tieInterval = null;
        }
        this._canSubmitDiceAnswer = false;
        this._isShowingDice = false;
        this._processTieResults(room, id, players);
      }
    }, (CONSTANTS.TIE_BREAKER_TIME_LIMIT || 20) * 1000 + 2000);
  }

  async _processTieResults(room, id, players) {
    if (this._processingTieResults) return;
    this._processingTieResults = true;
    
    try {
      let highest = 0, highestPlayers = [], answeredPlayers = [];
      
      for (const player of players) {
        const answer = this._tieAnswers.get(player);
        if (answer !== undefined && answer >= 1 && answer <= 6) {
          answeredPlayers.push(player);
          if (answer > highest) {
            highest = answer;
            highestPlayers = [player];
          } else if (answer === highest) {
            highestPlayers.push(player);
          }
        }
      }
      
      if (answeredPlayers.length === 0) {
        this._broadcastToRoom(DICE_ROOM, ["diceNotification", "No one answered"]);
        this._resetTieBreakerState(id);
        this._startTimeUpCooldown();
        this._processingTieResults = false;
        return;
      }
      
      if (highestPlayers.length === 1) {
        const winner = highestPlayers[0];
        await this.diceGameSystem.addPoints(winner, 1);
        const points = await this.diceGameSystem.getPoints();
        this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
          username: winner,
          totalPoints: points[winner] || 0,
          diceValue: highest,
          round: this._diceRound || 1,
          isTieBreaker: true,
          tieBreakerRound: this._tieRound,
          finalWinner: true
        }]);
        this._resetTieBreakerState(id);
        this._startTimeUpCooldown();
        this._processingTieResults = false;
        return;
      }
      
      if (highestPlayers.length > 1) {
        this._tiePlayers = highestPlayers;
        this._tieAnswers = new Map();
        setTimeout(() => {
          if (this._tieActive && this._tiePlayers.length > 1) {
            this._runTieRound(room, id, this._tiePlayers);
          } else if (this._tiePlayers.length === 1) {
            const winner = this._tiePlayers[0];
            this.diceGameSystem.addPoints(winner, 1);
            this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
              username: winner,
              totalPoints: 1,
              diceValue: 'auto',
              round: this._diceRound || 1,
              isTieBreaker: true,
              finalWinner: true
            }]);
            this._resetTieBreakerState(id);
            this._startTimeUpCooldown();
          }
          this._processingTieResults = false;
        }, 2000);
        return;
      }
      
      this._resetTieBreakerState(id);
      this._startTimeUpCooldown();
      this._processingTieResults = false;
    } catch(e) {
      this._processingTieResults = false;
    }
  }

  _resetTieBreakerState(id) {
    if (id) this._tieBreakers.delete(id);
    this._tieActive = false;
    this._tiePlayers = [];
    this._tieAnswers = new Map();
    this._tieRound = 0;
    this._canSubmitDiceAnswer = false;
    this._isShowingDice = false;
    this.diceAnswered = new Set();
    this._processingTieResults = false;
    if (this._tieTimer) clearTimeout(this._tieTimer);
    if (this._tieInterval) clearInterval(this._tieInterval);
  }

  // ==================== LOWCARD GAME METHODS ====================

  _sendGameStateToClient(ws, room) {
    try {
      if (!ws || ws.readyState !== 1 || !room) return;
      
      const game = this.activeGames.get(room);
      if (!game || !game._isActive || game._gameEnded) {
        this._safeSend(ws, ["gameState", { room, hasGame: false, gameType: 'lowcard' }]);
        return;
      }
      
      const activePlayers = this._getActivePlayers(game);
      this._safeSend(ws, ["gameState", {
        room, hasGame: true, gameType: 'lowcard',
        isActive: game._isActive, phase: game._phase || 'registration',
        round: game.round || 1, bet: game.betAmount || 0,
        host: game.hostName || 'Unknown',
        registrationOpen: game.registrationOpen || false,
        players: Array.from(game.players.values()).map(p => p.name),
        activePlayers: activePlayers.map(p => p.name),
        eliminated: Array.from(game.eliminated || []),
        submitted: Array.from(game.numbers?.keys() || []),
        playerCount: game.players.size,
        activeCount: activePlayers.length,
        isEvaluating: game._isEvaluating || false,
        evaluationLocked: game.evaluationLocked || false,
        drawTimeExpired: game.drawTimeExpired || false
      }]);
      
      if (game._phase === 'draw' && ws.username) {
        const userNumber = game.numbers.get(ws.username);
        if (userNumber !== undefined) {
          this._safeSend(ws, ["gameLowCardPlayerDraw", ws.username, userNumber, game.tanda.get(ws.username) || '']);
        }
      }
    } catch(e) {}
  }

  async _sendWinnersToRoom(room) {
    try {
      if (!room) return;
      const isRecordingEnabled = await this._getRecordingStatusFromKV(room);
      const winners = await this._getLowCardWinners(room);
      this._broadcastToRoom(room, ["lowCardWinnerUpdate", {
        winners: winners,
        room: room,
        recording: isRecordingEnabled
      }]);
    } catch(e) {}
  }

  async _startGame(ws, bet, username) {
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username?.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      
      const usernameClean = username.trim();
      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      if (room === DICE_ROOM) {
        this._safeSend(ws, ["gameLowCardError", "Cannot start game in Quiz room"]);
        return;
      }

      const isRecordingEnabled = await this._getRecordingStatusFromKV(room);
      if (isRecordingEnabled) {
        this._safeSend(ws, ["gameLowCardError", "Recording is ACTIVE in this room"]);
        return;
      }

      const existingGame = this.activeGames.get(room);
      if (existingGame?._isActive && !existingGame._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "Game is already running"]);
        return;
      }
      
      if (existingGame) {
        await this._forceCleanupGame(room, existingGame);
      }
      
      const betAmount = parseInt(bet, 10) || 0;
      if (betAmount < 0 || (betAmount !== 0 && betAmount < 100) || betAmount > CONSTANTS.MAX_BET) {
        this._safeSend(ws, ["gameLowCardError", `Invalid bet (0 or 100-${CONSTANTS.MAX_BET})`]);
        return;
      }
      
      if (this.activeGames.size >= this._maxGames) {
        this._safeSend(ws, ["gameLowCardError", "Server is busy"]);
        return;
      }
      
      const wsId = ws._wsId;
      const game = {
        room, players: new Map(), botPlayers: new Map(), registrationOpen: true,
        round: 1, numbers: new Map(), tanda: new Map(), eliminated: new Set(),
        betAmount, hostId: usernameClean, hostName: usernameClean,
        evaluationLocked: false, drawTimeExpired: false,
        _isActive: true, _gameEnded: false, _phase: 'registration',
        _botTimeouts: new Set(), _botsAdded: false,
        _evalTimer: null, _safetyTimer: null,
        _isEvaluating: false, _createdAt: Date.now(), _drawPhaseStart: null,
        _registrationStartTime: Date.now(),
        playerWsId: new Map(),
        _startedBy: 'user'
      };
      
      game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
      game.playerWsId.set(usernameClean, wsId);
      this.activeGames.set(room, game);
      this._addClient(room, ws, usernameClean, false);
      this._broadcastToRoom(room, ["gameLowCardStart", betAmount]);
      this._broadcastToRoom(room, ["gameLowCardStartSuccess", usernameClean, betAmount]);
      
    } catch(e) {}
  }

  async _joinGame(ws, username) {
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username?.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      
      const usernameClean = username.trim();
      const wsId = ws._wsId;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game in this room"]);
        return;
      }
      if (game.players.has(usernameClean)) {
        if (game.eliminated?.has(usernameClean)) {
          this._safeSend(ws, ["gameLowCardError", "You have been eliminated"]);
          return;
        }
        this._sendGameStateToClient(ws, room);
        return;
      }
      if (!game.registrationOpen) {
        this._safeSend(ws, ["gameLowCardNoJoin", usernameClean, game.betAmount]);
        this._safeSend(ws, ["gameLowCardError", "Registration is closed"]);
        return;
      }
      if (game.players.size >= CONSTANTS.MAX_PLAYERS_PER_GAME) {
        this._safeSend(ws, ["gameLowCardError", "Game is full"]);
        return;
      }
      
      game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
      this._addClient(room, ws, usernameClean, false);
      game.playerWsId.set(usernameClean, wsId);
      this._broadcastToRoom(room, ["gameLowCardJoin", usernameClean, game.betAmount]);
      this._sendGameStateToClient(ws, room);
    } catch(e) {}
  }

  async _submitNumber(ws, number, tanda, username) {
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username?.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      
      const usernameClean = username.trim();
      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game"]);
        return;
      }
      if (game.registrationOpen || game.evaluationLocked || game.drawTimeExpired || game._phase !== 'draw') {
        this._safeSend(ws, ["gameLowCardError", "Cannot submit now"]);
        return;
      }
      if (!game.players.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You are not in this game"]);
        return;
      }
      if (game.eliminated.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You have been eliminated"]);
        return;
      }
      if (game.numbers.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You have already submitted"]);
        return;
      }
      
      const n = parseInt(number, 10);
      if (isNaN(n) || n < 1 || n > 12) {
        this._safeSend(ws, ["gameLowCardError", "Invalid number (1-12)"]);
        return;
      }
      
      const validTandas = ["C1", "C2", "C3", "C4", ""];
      if (!validTandas.includes(tanda)) tanda = "";
      
      game.numbers.set(usernameClean, n);
      game.tanda.set(usernameClean, tanda);
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", usernameClean, n, tanda]);
      
      const activeIds = this._getActivePlayerIds(game);
      if (game.numbers.size === activeIds.length && !game.evaluationLocked && !game.drawTimeExpired) {
        game.evaluationLocked = true;
        if (game._evalTimer) clearTimeout(game._evalTimer);
        this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
        game._evalTimer = setTimeout(() => {
          this._evaluateRound(room, game);
        }, CONSTANTS.EVALUATION_DELAY_MS);
      }
    } catch(e) {}
  }

  async _leaveGame(ws, username) {
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username?.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      
      const usernameClean = username.trim();
      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game in this room"]);
        return;
      }
      if (!game.players.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You are not in this game"]);
        return;
      }
      
      this._removePlayerFromGame(usernameClean, room);
      this._sendGameStateToClient(ws, room);
    } catch(e) {}
  }

  async _checkGameRunning(ws, roomname) {
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameStatus", "false"]);
        return;
      }
      const room = roomname || ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room) {
        this._safeSend(ws, ["gameStatus", "false"]);
        return;
      }
      const game = this.activeGames.get(room);
      const isRunning = game?._isActive && !game._gameEnded && game.players?.size > 0;
      this._safeSend(ws, ["gameStatus", isRunning ? "true" : "false"]);
      if (isRunning) this._sendGameStateToClient(ws, room);
    } catch(e) {}
  }

  // ==================== GAME STATE METHODS ====================

  _isGameActuallyRunning(game) { 
    try { 
      return game?._isActive === true && !game?._gameEnded; 
    } catch(e) { 
      return false; 
    } 
  }

  _addBots(room, count) {
    try {
      const game = this.activeGames.get(room);
      if (!this._isGameActuallyRunning(game)) return;
      const botNames = ["moz1", "moz2", "moz3", "moz4"];
      const existingBots = Array.from(game.players.keys()).filter(id => id.startsWith('BOT_'));
      const maxBotsToAdd = Math.min(count, CONSTANTS.MAX_BOTS_PER_GAME - existingBots.length);
      if (maxBotsToAdd <= 0) return;
      
      for (let i = 0; i < maxBotsToAdd; i++) {
        const botId = `BOT_${room}_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const botName = botNames[(existingBots.length + i) % botNames.length];
        if (!game.players.has(botId)) {
          game.players.set(botId, { id: botId, name: botName });
          if (!game.botPlayers) game.botPlayers = new Map();
          game.botPlayers.set(botId, botName);
        }
      }
      game._botsAdded = true;
    } catch(e) {}
  }

  _closeRegistration(room, game) {
    try {
      if (!this._isGameActuallyRunning(game) || !game.registrationOpen) return;
      game.registrationOpen = false;
      
      const humanPlayers = Array.from(game.players.keys()).filter(id => !id.startsWith('BOT_'));
      if (!game._botsAdded && game.players.size < 2) {
        const needed = Math.min(4 - game.players.size, CONSTANTS.MAX_BOTS_PER_GAME);
        if (needed > 0) {
          this._addBots(room, needed);
          game._botsAdded = true;
        }
      }
      
      if (this._isGameActuallyRunning(game) && game.players.size >= 2) {
        this._startDrawPhase(room, game);
      } else {
        game._gameEnded = true;
        game._isActive = false;
        this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
        this._scheduleGameCleanup(room, game);
      }
    } catch(e) {}
  }

  async _startDrawPhase(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._drawTimer) clearInterval(game._drawTimer);
      if (game._evalTimer) clearTimeout(game._evalTimer);
      
      const activePlayers = this._getActivePlayers(game);
      if (activePlayers.length < 2) {
        if (!game._botsAdded) {
          const needed = Math.min(4 - activePlayers.length, CONSTANTS.MAX_BOTS_PER_GAME);
          if (needed > 0) { 
            this._addBots(room, needed); 
            game._botsAdded = true; 
          }
        }
        const newActive = this._getActivePlayers(game);
        if (newActive.length < 2) {
          if (newActive.length === 1 && !game._gameEnded) {
            const winner = newActive[0]?.name || "Unknown";
            const totalCoin = (game.betAmount || 0) * (game.players?.size || 0);
            await this._addLowCardWinner(room, winner);
            game._gameEnded = true;
            game._isActive = false;
            this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
            this._scheduleGameCleanup(room, game);
          } else {
            game._gameEnded = true;
            game._isActive = false;
            this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
            this._scheduleGameCleanup(room, game);
          }
          return;
        }
      }
      
      game._phase = 'draw';
      game.drawTimeExpired = false;
      game.evaluationLocked = false;
      game._drawPhaseStart = Date.now();
      if (!game._botTimeouts) game._botTimeouts = new Set();
      
      const playersList = this._getActivePlayers(game).map(p => p.name);
      this._broadcastToRoom(room, ["gameLowCardClosed", playersList]);
      this._broadcastToRoom(room, ["gameLowCardNextRound", game.round]);
      
      if (game.botPlayers?.size > 0 && this._isGameActuallyRunning(game)) {
        this._startBotDraws(room, game);
      }
    } catch(e) {}
  }

  _closeDrawPhase(room, game) {
    try {
      if (!this._isGameActuallyRunning(game) || game.drawTimeExpired || game.evaluationLocked) return;
      game.drawTimeExpired = true;
      game.evaluationLocked = true;
      if (game._drawTimer) clearInterval(game._drawTimer);
      
      if (game.botPlayers?.size > 0 && this._isGameActuallyRunning(game)) {
        const activeBotIds = Array.from(game.botPlayers.keys())
          .filter(id => !game.eliminated?.has(id) && !game.numbers?.has(id));
        for (const botId of activeBotIds) {
          const number = this._getBotNumberByRound(game.round);
          const tanda = this._getRandomCardTanda();
          game.numbers.set(botId, number);
          game.tanda.set(botId, tanda);
          const botName = game.players.get(botId)?.name || botId;
          this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
        }
      }
      
      this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
      if (game._evalTimer) clearTimeout(game._evalTimer);
      game._evalTimer = setTimeout(() => {
        this._evaluateRound(room, game);
      }, CONSTANTS.EVALUATION_DELAY_MS);
    } catch(e) {}
  }

  _startBotDraws(room, game) {
    try {
      if (!this._isGameActuallyRunning(game) || !game.botPlayers) return;
      if (!game._botTimeouts) game._botTimeouts = new Set();
      
      const notDrawn = Array.from(game.botPlayers.keys())
        .filter(id => !game.eliminated?.has(id) && !game.numbers?.has(id))
        .slice(0, CONSTANTS.MAX_BOT_DRAWS_PER_ROUND);
      
      for (const botId of notDrawn) {
        const delay = this._getRandomDrawDelay();
        const timeout = setTimeout(() => {
          try {
            const currentGame = this.activeGames.get(room);
            if (this._isGameActuallyRunning(currentGame) && !currentGame.drawTimeExpired &&
                !currentGame.evaluationLocked && !currentGame.numbers?.has(botId) && !currentGame.eliminated?.has(botId)) {
              const number = this._getBotNumberByRound(currentGame.round);
              const tanda = this._getRandomCardTanda();
              currentGame.numbers.set(botId, number);
              currentGame.tanda.set(botId, tanda);
              const botName = currentGame.players.get(botId)?.name || botId;
              this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
              
              const activeIds = this._getActivePlayerIds(currentGame);
              if (currentGame.numbers.size === activeIds.length && !currentGame.evaluationLocked && !currentGame.drawTimeExpired) {
                currentGame.evaluationLocked = true;
                this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
                currentGame._evalTimer = setTimeout(() => { 
                  this._evaluateRound(room, currentGame); 
                }, CONSTANTS.EVALUATION_DELAY_MS);
              }
            }
          } catch(e) {}
        }, delay);
        game._botTimeouts.add(timeout);
      }
    } catch(e) {}
  }

  _getBotNumberByRound(round) {
    try {
      if (round <= 2) return Math.floor(Math.random() * 12) + 1;
      return Math.random() < 0.6 ?
        [8, 9, 10, 11, 12][Math.floor(Math.random() * 5)] :
        [1, 2, 3, 4, 5, 6, 7][Math.floor(Math.random() * 7)];
    } catch(e) { return 5; }
  }

  _getRandomCardTanda() { 
    try { 
      return ["C1", "C2", "C3", "C4"][Math.floor(Math.random() * 4)]; 
    } catch(e) { 
      return "C1"; 
    } 
  }

  _getRandomDrawDelay() { 
    try { 
      return (Math.floor(Math.random() * 14) + 2) * 1000; 
    } catch(e) { 
      return 5000; 
    } 
  }

  async _evaluateRound(room, game) {
    try {
      if (this.isDestroyed || !game?._isActive || game._gameEnded || game._isEvaluating || !game.players) return;
      
      game._isEvaluating = true;
      game._safetyTimer = setTimeout(() => {
        try { 
          if (game?._isEvaluating) { 
            game._isEvaluating = false; 
            this._scheduleGameCleanup(room, game); 
          } 
        } catch(e) {}
      }, CONSTANTS.EVALUATION_TIMEOUT_MS);
      
      if (game._evalTimer) clearTimeout(game._evalTimer);
      if (game._botTimeouts) {
        for (const id of game._botTimeouts) clearTimeout(id);
        game._botTimeouts.clear();
      }
      
      const numbers = game.numbers || new Map();
      const players = game.players || new Map();
      const eliminated = game.eliminated || new Set();
      const tanda = game.tanda || new Map();
      const entries = Array.from(numbers.entries());
      const submittedIds = new Set(numbers.keys());
      const activeIds = this._getActivePlayerIds(game);
      
      for (const id of activeIds) {
        if (!submittedIds.has(id)) eliminated.add(id);
      }
      
      if (entries.length === 0) {
        game._isEvaluating = false;
        if (game._safetyTimer) clearTimeout(game._safetyTimer);
        this._broadcastToRoom(room, ["gameLowCardError", "No numbers drawn"]);
        game._gameEnded = true;
        game._isActive = false;
        this._scheduleGameCleanup(room, game);
        return;
      }
      
      if (entries.length === 1 && eliminated.size >= activeIds.length - 1) {
        const winnerId = entries[0][0];
        const winnerName = players.get(winnerId)?.name || winnerId;
        const totalCoin = (game.betAmount || 0) * players.size;
        await this._addLowCardWinner(room, winnerName);
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        game._gameEnded = true;
        game._isActive = false;
        game._isEvaluating = false;
        if (game._safetyTimer) clearTimeout(game._safetyTimer);
        this._scheduleGameCleanup(room, game);
        return;
      }
      
      const activePlayerIds = this._getActivePlayerIds(game);
      if (game.numbers.size < activePlayerIds.length) {
        game._isEvaluating = false;
        if (game._safetyTimer) clearTimeout(game._safetyTimer);
        return;
      }
      
      const values = entries.map(([, n]) => n);
      const allSame = values.every(v => v === values[0]);
      let losers = [];
      
      if (!allSame && values.length > 0) {
        const lowest = Math.min(...values);
        losers = entries.filter(([, n]) => n === lowest).map(([id]) => id);
        for (const id of losers) eliminated.add(id);
      }
      
      const remaining = Array.from(players.keys()).filter(id => !eliminated.has(id));
      
      if (allSame && remaining.length >= 2) {
        game._isEvaluating = false;
        if (game._safetyTimer) clearTimeout(game._safetyTimer);
        numbers.clear();
        tanda.clear();
        game.round++;
        game.evaluationLocked = false;
        game.drawTimeExpired = false;
        game._phase = 'draw';
        game.numbers = new Map();
        game.tanda = new Map();
        game._botTimeouts = new Set();
        
        const remainingNames = remaining.map(id => players.get(id)?.name || id);
        this._broadcastToRoom(room, ["gameLowCardRoundResult", game.round - 1,
          entries.map(([id, n]) => `${players.get(id)?.name || id}:${n}${tanda.get(id) ? `(${tanda.get(id)})` : ''}`),
          [], remainingNames, true
        ]);
        
        if (this._isGameActuallyRunning(game) && !game._gameEnded) {
          this._startDrawPhase(room, game);
        }
        return;
      }
      
      if (remaining.length === 1 && !game._gameEnded) {
        const winnerId = remaining[0];
        const winnerName = players.get(winnerId)?.name || winnerId;
        const totalCoin = (game.betAmount || 0) * players.size;
        await this._addLowCardWinner(room, winnerName);
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        game._gameEnded = true;
        game._isActive = false;
        game._isEvaluating = false;
        if (game._safetyTimer) clearTimeout(game._safetyTimer);
        this._scheduleGameCleanup(room, game);
        return;
      }
      
      if (remaining.length === 0) {
        game._isEvaluating = false;
        if (game._safetyTimer) clearTimeout(game._safetyTimer);
        game._gameEnded = true;
        game._isActive = false;
        this._broadcastToRoom(room, ["gameLowCardError", "All players eliminated"]);
        this._scheduleGameCleanup(room, game);
        return;
      }
      
      const numbersArr = entries.map(([id, n]) => `${players.get(id)?.name || id}:${n}${tanda.get(id) ? `(${tanda.get(id)})` : ''}`);
      const loserNames = [...losers].map(id => players.get(id)?.name || id);
      const remainingNames = remaining.map(id => players.get(id)?.name || id);
      
      this._broadcastToRoom(room, ["gameLowCardRoundResult", game.round, numbersArr, loserNames, remainingNames]);
      
      numbers.clear();
      tanda.clear();
      game.round++;
      game.evaluationLocked = false;
      game.drawTimeExpired = false;
      game._phase = 'draw';
      game.numbers = new Map();
      game.tanda = new Map();
      game._botTimeouts = new Set();
      game._isEvaluating = false;
      
      if (game._safetyTimer) clearTimeout(game._safetyTimer);
      
      if (this._isGameActuallyRunning(game) && !game._gameEnded) {
        this._startDrawPhase(room, game);
      }
      
    } catch(e) {}
  }

  _scheduleGameCleanup(room, game) {
    try {
      if (!room || !game) return;
      if (this._cleanupTimers.has(room)) {
        const oldTimer = this._cleanupTimers.get(room);
        if (oldTimer) clearTimeout(oldTimer);
        this._cleanupTimers.delete(room);
      }
      if (!game._gameEnded) return;
      const timer = setTimeout(() => {
        try {
          const currentGame = this.activeGames.get(room);
          if (currentGame?._isActive && !currentGame._gameEnded) { 
            this._cleanupTimers.delete(room); 
            return; 
          }
          this._cleanupTimers.delete(room);
          const gameToDelete = this.activeGames.get(room);
          if (gameToDelete) this._deleteGame(room, gameToDelete);
        } catch(e) {}
      }, CONSTANTS.GAME_CLEANUP_DELAY_MS);
      this._cleanupTimers.set(room, timer);
    } catch(e) {}
  }

  _deleteGame(room, game) {
    try {
      if (!room || !game) return;
      if (game?._isActive && !game._gameEnded) return;
      if (this._cleanupTimers.has(room)) { 
        clearTimeout(this._cleanupTimers.get(room)); 
        this._cleanupTimers.delete(room); 
      }
      this.activeGames.delete(room);
      this._gameLocks.delete(room);
      this._joinLocks.delete(room);
      this._gameStartFlags.delete(room);
      this._broadcastToRoom(room, ["gameLowCardEnd", []]);
    } catch(e) {}
  }

  _removePlayerFromGame(username, room) {
    try {
      const game = this.activeGames.get(room);
      if (!game || !game.players?.has(username) || !game._isActive || game._gameEnded || game._isEvaluating || game.evaluationLocked) return false;
      if (!game.eliminated) game.eliminated = new Set();
      game.eliminated.add(username);
      game.numbers?.delete(username);
      game.tanda?.delete(username);
      this._broadcastToRoom(room, ["gameLowCardError", `${username} has been eliminated`]);
      setTimeout(() => {
        try {
          const currentGame = this.activeGames.get(room);
          if (currentGame && currentGame === game && !game._gameEnded) this._checkGameCanContinue(room, game);
        } catch(e) {}
      }, 1000);
      return true;
    } catch(e) { return false; }
  }

  async _checkGameCanContinue(room, game) {
    try {
      if (!game?._isActive || game._gameEnded || !game.players || game._isEvaluating || game.evaluationLocked || game.registrationOpen) return;
      
      const activePlayers = this._getActivePlayers(game);
      if (activePlayers.length === 0) {
        game._gameEnded = true;
        game._isActive = false;
        this._broadcastToRoom(room, ["gameLowCardEnd", []]);
        this._scheduleGameCleanup(room, game);
        return;
      }
      
      if (activePlayers.length === 1 && !game._gameEnded) {
        const winner = activePlayers[0]?.name || "Unknown";
        const totalCoin = (game.betAmount || 0) * (game.players?.size || 0);
        await this._addLowCardWinner(room, winner);
        game._gameEnded = true;
        game._isActive = false;
        this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
        this._scheduleGameCleanup(room, game);
      }
    } catch(e) {}
  }

  async _forceCleanupGame(room, game) {
    try {
      if (!game) return;
      const timers = ['_registrationTimer', '_drawTimer', '_evalTimer', '_safetyTimer'];
      for (const key of timers) {
        if (game[key]) { 
          clearTimeout(game[key]); 
          clearInterval(game[key]); 
          game[key] = null; 
        }
      }
      if (game._botTimeouts) { 
        for (const id of game._botTimeouts) clearTimeout(id); 
        game._botTimeouts.clear(); 
      }
      game._gameEnded = true;
      game._isActive = false;
      this._broadcastToRoom(room, ["gameLowCardEnd", []]);
      this.activeGames.delete(room);
      if (this._cleanupTimers.has(room)) { 
        clearTimeout(this._cleanupTimers.get(room)); 
        this._cleanupTimers.delete(room); 
      }
    } catch(e) {}
  }

  _getActivePlayers(game) {
    try {
      if (!game?._isActive || game?._gameEnded || !game?.players) return [];
      return Array.from(game.players.entries())
        .filter(([id]) => !game.eliminated?.has(id))
        .map(([, p]) => p);
    } catch(e) { return []; }
  }

  _getActivePlayerIds(game) {
    try {
      if (!game?._isActive || game._gameEnded || !game?.players) return [];
      return Array.from(game.players.keys()).filter(id => !game.eliminated?.has(id));
    } catch(e) { return []; }
  }

  // ==================== SWITCH ROOM ====================

  async _switchRoom(ws, room, username) {
    try {
      if (this.isDestroyed) { 
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); 
        return; 
      }
      if (!room || room.trim() === "") { 
        this._safeSend(ws, ["gameLowCardError", "Invalid room name"]); 
        return; 
      }
      const roomName = room.trim();
      const wsId = ws._wsId;
      if (!wsId) { 
        this._safeSend(ws, ["gameLowCardError", "Connection error"]); 
        return; 
      }
      
      const currentRoom = ws.room || ws.roomname || this.clientRooms.get(wsId);
      if (currentRoom) {
        this._removeClientFromRoom(currentRoom, wsId);
      }
      
      this._addClient(roomName, ws, username || null, false);
      ws.room = roomName;
      ws.roomname = roomName;
      if (username) ws.username = username;
      
      this._safeSend(ws, ["switchRoomSuccess", roomName]);
      this._sendGameStateToClient(ws, roomName);
      
      this._broadcastToRoom(roomName, ["userJoinedRoom", username, roomName]);
      if (currentRoom && currentRoom !== roomName) {
        this._broadcastToRoom(currentRoom, ["userLeftRoom", username, currentRoom]);
      }
      
    } catch(e) {}
  }

  // ==================== HELPER METHODS ====================

  _addClient(room, ws, username = null, isNewConnection = false) {
    try {
      if (!ws) return;
      const wsId = ws._wsId;
      if (!wsId) { 
        this._safeSend(ws, ["gameLowCardError", "Connection error"]); 
        return; 
      }
      
      if (this.clientRooms.has(wsId)) {
        const oldRoom = this.clientRooms.get(wsId);
        if (oldRoom && oldRoom !== room) {
          this._removeClientFromRoom(oldRoom, wsId);
        }
      }
      
      if (username) {
        let conn = this.userConnections.get(username);
        if (conn) { 
          conn.room = room; 
          conn.timestamp = Date.now(); 
          conn.ws = ws; 
          conn.wsId = wsId;
        } else { 
          this.userConnections.set(username, { 
            wsId, 
            ws, 
            room, 
            timestamp: Date.now() 
          }); 
        }
      }
      
      let clients = this.wsClients.get(room);
      if (!clients) {
        clients = new Set();
        this.wsClients.set(room, clients);
      }
      clients.add(wsId);
      
      this.clientRooms.set(wsId, room);
      this.wsMap.set(wsId, ws);
      ws.room = room;
      ws.roomname = room;
      if (username) ws.username = username;
      
    } catch(e) {}
  }

  _removeClientFromRoom(room, wsId) {
    try {
      if (!room || !wsId) return;
      const clients = this.wsClients.get(room);
      if (clients) {
        clients.delete(wsId);
        if (clients.size === 0) {
          this.wsClients.delete(room);
        }
      }
    } catch(e) {}
  }

  // ==================== CLEANUP TASKS ====================
  
  _checkStuckGames() {
    try {
      const now = Date.now();
      for (const [room, game] of this.activeGames) {
        if (!game?._isActive || game._gameEnded) continue;
        
        if (game._phase === 'draw' && game._drawPhaseStart &&
            (now - game._drawPhaseStart) > CONSTANTS.STUCK_DRAW_TIMEOUT_MS) {
          this._closeDrawPhase(room, game);
        }
        
        if (game._phase === 'registration' && game.registrationOpen &&
            game._createdAt && (now - game._createdAt) > CONSTANTS.STUCK_REGISTRATION_TIMEOUT_MS) {
          this._closeRegistration(room, game);
        }
      }
    } catch(e) {}
  }

  _cleanupStaleGames() {
    try {
      const now = Date.now();
      for (const [room, game] of this.activeGames) {
        if (!game) continue;
        if (game._isActive && !game._gameEnded) continue;
        if (game._gameEnded) {
          const endTime = game._endTime || game._createdAt || now;
          if ((now - endTime) > CONSTANTS.STALE_GAME_TIMEOUT_MS) {
            this._scheduleGameCleanup(room, game);
          }
        }
      }
    } catch(e) {}
  }

  _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const [wsId, ws] of this.wsMap) {
        if (!ws || ws.readyState !== 1 || ws._closing) toRemove.push(wsId);
      }
      for (const wsId of toRemove) {
        const ws = this.wsMap.get(wsId);
        if (ws) {
          const room = this.clientRooms.get(wsId);
          if (room) this._removeClientFromRoom(room, wsId);
          this.clientRooms.delete(wsId);
          this.wsMap.delete(wsId);
        }
      }
    } catch(e) {}
  }

  // ==================== FETCH ====================

  async fetch(req) {
    try {
      if (this.closing || this.isDestroyed) {
        return new Response("Server is shutting down", { status: 503 });
      }
      
      const url = new URL(req.url);
      
      if (url.pathname === "/health") {
        const status = {
          status: "ok",
          uptime: Date.now() - this._startTime,
          diceActive: !!this.currentDiceRoll,
          diceRound: this._diceRound || 0,
          gamesRunning: this.activeGames.size,
          wsConnections: this.wsMap.size,
          timestamp: Date.now()
        };
        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === "/game/ws") {
        const upgrade = req.headers.get("Upgrade");
        if (upgrade !== "websocket") {
          return new Response("WebSocket only", { status: 400 });
        }
        
        if (this.wsMap.size >= CONSTANTS.MAX_WS_CLIENTS) {
          return new Response("Server at maximum capacity", { status: 503 });
        }
        
        try {
          const pair = new WebSocketPair();
          const [client, server] = [pair[0], pair[1]];
          const wsId = ++this._wsIdCounter;
          
          server._wsId = wsId;
          server._closing = false;
          server.room = null;
          server.roomname = null;
          server._createdAt = Date.now();
          server.username = null;
          
          try { 
            this.state.acceptWebSocket(server); 
          } catch(e) { 
            return new Response("WebSocket acceptance failed", { status: 500 }); 
          }
          
          server.addEventListener("message", async (event) => {
            try {
              const data = JSON.parse(event.data);
              if (Array.isArray(data) && data.length > 0) {
                await this.handleEvent(server, data);
              }
            } catch(e) { 
              this._safeSend(server, ["gameLowCardError", e.message || "Error"]); 
            }
          });
          
          server.addEventListener("close", () => {
            this.webSocketClose(server);
          });
          
          server.addEventListener("error", () => {
            this.webSocketError(server);
          });
          
          return new Response(null, { status: 101, webSocket: client });
        } catch(e) {
          return new Response("WebSocket creation failed", { status: 500 });
        }
      }
      
      return new Response("Game Server", { status: 200 });
    } catch(e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ==================== WEBSOCKET EVENTS ====================

  webSocketClose(ws) {
    try {
      if (!ws) return;
      ws._closing = true;
      
      const wsId = ws._wsId;
      const username = ws.username;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      
      if (room) this._removeClientFromRoom(room, wsId);
      if (wsId) {
        this.clientRooms.delete(wsId);
        this.wsMap.delete(wsId);
      }
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
      }
      
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
    } catch(e) {}
  }

  webSocketError(ws) {
    try {
      if (!ws) return;
      ws._closing = true;
      
      const wsId = ws._wsId;
      const username = ws.username;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      
      if (room) this._removeClientFromRoom(room, wsId);
      if (wsId) {
        this.clientRooms.delete(wsId);
        this.wsMap.delete(wsId);
      }
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
      }
      
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
    } catch(e) {}
  }

  // ==================== DESTROY ====================

  async destroy() {
    try {
      if (this.isDestroyed) return;
      this.isDestroyed = true;
      this.closing = true;
      
      if (this._masterInterval) {
        clearInterval(this._masterInterval);
        this._masterInterval = null;
      }
      
      if (this._gameScheduler) {
        this._gameScheduler.stop();
      }
      
      if (this._broadcastBuffer) {
        this._broadcastBuffer.clear();
      }
      
      this._recordingCache.clear();
      this._winnerCache.clear();
      this._lastWeekWinnerCache = null;
      this._isWinnerCacheReady = false;
      this._isRecordingCacheReady = false;
      
      this.diceGameSystem.clearCache();
      
      for (const [room, game] of this.activeGames) {
        await this._forceCleanupGame(room, game);
      }
      this.activeGames.clear();
      
      if (this._diceTimeout) clearTimeout(this._diceTimeout);
      if (this._diceStartTimeout) clearTimeout(this._diceStartTimeout);
      if (this._diceTimeUpCooldownTimer) clearTimeout(this._diceTimeUpCooldownTimer);
      
      this.currentDiceRoll = null;
      this.diceHasWinner = false;
      this.diceWinner = null;
      this._isShowingDice = false;
      this._canSubmitDiceAnswer = false;
      this._tieActive = false;
      this._tieBreakers.clear();
      
      for (const [wsId, ws] of this.wsMap) {
        try {
          if (ws && ws.readyState === 1) {
            ws.close(1000, "Server shutting down");
          }
        } catch(e) {}
      }
      this.wsMap.clear();
      this.wsClients.clear();
      this.clientRooms.clear();
      
      this._eventQueue = [];
      this._rateLimitMap.clear();
      
    } catch(e) {}
  }
}
