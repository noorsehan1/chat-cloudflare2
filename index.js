// ==================== INDEX.JS - CHAT & GAME SERVER (TANPA DURABLE OBJECTS) ====================
import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

let chatServer = null;
let gameServer = null;
let isInitialized = false;

// ==================== HELPER FUNCTIONS ====================

// Helper untuk membuat ChatServer (tanpa Durable Objects)
function createChatServer(env) {
  return new ChatServer(env);
}

// Helper untuk membuat GameServer (tanpa Durable Objects)
function createGameServer(env) {
  return new GameServer(env);
}

// ==================== MAIN WORKER ====================

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // ==================== INISIALISASI ====================
      if (!isInitialized) {
        try {
          // Initialize Chat Server
          chatServer = createChatServer(env);
          if (chatServer._initPromise) {
            await chatServer._initPromise;
          }
          
          // Initialize Game Server
          gameServer = createGameServer(env);
          if (gameServer._initPromise) {
            await gameServer._initPromise;
          }
          
          isInitialized = true;
          console.log('✅ Servers initialized with D1 Database');
          console.log(`✅ Chat Rooms: ${chatServer.ROOMS?.length || 0}`);
          console.log(`✅ Game Rooms: ${gameServer.GAME_ROOMS?.length || 0}`);
        } catch(e) {
          console.error('❌ Initialization error:', e);
          isInitialized = false;
        }
      }
      
      // ==================== CHAT ROUTES ====================
      if (pathname === "/ws" || pathname === "/chat" || pathname === "/") {
        if (!chatServer || chatServer.isDestroyed) {
          chatServer = createChatServer(env);
          if (chatServer._initPromise) {
            await chatServer._initPromise;
          }
        }
        
        try {
          return await chatServer.fetch(request);
        } catch (error) {
          console.error('❌ ChatServer fetch error:', error);
          if (chatServer) {
            try { await chatServer.destroy(); } catch(e) {}
          }
          chatServer = null;
          isInitialized = false;
          
          return new Response('Chat service temporarily unavailable', { 
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      }
      
      // ==================== GAME ROUTES ====================
      if (pathname === "/game/ws" || pathname === "/game") {
        if (!gameServer || gameServer.isDestroyed) {
          gameServer = createGameServer(env);
          if (gameServer._initPromise) {
            await gameServer._initPromise;
          }
        }
        
        try {
          return await gameServer.fetch(request);
        } catch (error) {
          console.error('❌ GameServer fetch error:', error);
          if (gameServer) {
            try { await gameServer.destroy(); } catch(e) {}
          }
          gameServer = null;
          isInitialized = false;
          
          return new Response('Game service temporarily unavailable', { 
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      }
      
      // ==================== API ROUTES ====================
      
      // GET CHAT ROOM INFO
      if (pathname === "/api/rooms") {
        if (!chatServer || chatServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Chat server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const db = chatServer.db;
          const roomStats = {};
          
          for (const room of chatServer.ROOMS || []) {
            const count = await db.getSeatsCount(room);
            const roomData = await db.getRoom(room);
            roomStats[room] = {
              count: count,
              muted: roomData?.muted || false,
              number: roomData?.number || 1,
              maxSeats: 45
            };
          }
          
          return new Response(JSON.stringify({
            success: true,
            type: 'chat',
            rooms: roomStats,
            totalUsers: Object.values(roomStats).reduce((sum, r) => sum + r.count, 0),
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get room stats' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // GET ONLINE USERS - Chat
      if (pathname === "/api/users") {
        if (!chatServer || chatServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Chat server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const onlineUsers = [];
          for (const [username, seatInfo] of chatServer.userSeat) {
            if (seatInfo?.seat) {
              onlineUsers.push({
                username: username,
                room: seatInfo.room,
                seat: seatInfo.seat,
                isMulti: seatInfo.isMulti || false
              });
            }
          }
          
          return new Response(JSON.stringify({
            success: true,
            total: onlineUsers.length,
            users: onlineUsers,
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get users' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // GET GAME ROOMS
      if (pathname === "/api/game/rooms") {
        if (!gameServer || gameServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Game server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const gameRooms = {};
          
          for (const room of gameServer.GAME_ROOMS || []) {
            const game = gameServer.activeGames?.get(room);
            const roomData = await gameServer.db.getGameRoom(room);
            const count = await gameServer.db.getGamePlayersCount(room);
            
            gameRooms[room] = {
              count: count || 0,
              status: game?._isActive && !game._gameEnded ? 'playing' : roomData?.status || 'waiting',
              currentRound: game?.round || roomData?.current_round || 0,
              maxRounds: roomData?.max_rounds || 5,
              gameType: roomData?.game_type || 'quiz',
              phase: game?._phase || 'idle'
            };
          }
          
          return new Response(JSON.stringify({
            success: true,
            type: 'game',
            rooms: gameRooms,
            totalPlayers: Object.values(gameRooms).reduce((sum, r) => sum + r.count, 0),
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get game rooms' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // GET GAME PLAYERS
      if (pathname === "/api/game/players") {
        const roomName = url.searchParams.get('room');
        if (!roomName) {
          return new Response(JSON.stringify({ error: 'Room name required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        if (!gameServer || gameServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Game server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const game = gameServer.activeGames?.get(roomName);
          let players = [];
          
          if (game && game._isActive && !game._gameEnded && game.players) {
            players = Array.from(game.players.entries()).map(([id, p]) => ({
              playerId: id,
              name: p.name || id,
              seat: game.playerWsId?.get(id) ? 1 : 0,
              score: 0,
              isReady: true,
              isEliminated: game.eliminated?.has(id) || false,
              hasSubmitted: game.numbers?.has(id) || false,
              number: game.numbers?.get(id) || null,
              tanda: game.tanda?.get(id) || null
            }));
          } else {
            const dbPlayers = await gameServer.db.getGamePlayers(roomName);
            players = dbPlayers.map(p => ({
              playerId: p.player_id,
              name: p.player_id,
              seat: p.seat_number,
              score: p.score || 0,
              isReady: p.is_ready === 1,
              isEliminated: false,
              hasSubmitted: false,
              number: null,
              tanda: null
            }));
          }
          
          return new Response(JSON.stringify({
            success: true,
            room: roomName,
            total: players.length,
            players: players,
            gameActive: game?._isActive || false,
            gamePhase: game?._phase || 'idle',
            round: game?.round || 0,
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get players' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // GET DICE STATUS
      if (pathname === "/api/dice/status") {
        if (!gameServer || gameServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Game server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const isDiceTime = gameServer._isDiceTime ? gameServer._isDiceTime() : false;
          const timeLeft = gameServer._getTimeLeftUntilNextDice ? gameServer._getTimeLeftUntilNextDice() : { text: '0h 0m' };
          const currentRoll = gameServer.currentDiceRoll;
          
          let points = {};
          if (gameServer.diceGameSystem) {
            points = await gameServer.diceGameSystem.getPoints();
          }
          
          const sortedPoints = Object.entries(points)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
          
          return new Response(JSON.stringify({
            success: true,
            isDiceTime: isDiceTime,
            timeLeft: timeLeft.text,
            currentRoll: currentRoll ? {
              value: currentRoll.value,
              round: currentRoll.round || 1,
              timestamp: currentRoll.timestamp
            } : null,
            isShowing: gameServer._isShowingDice || false,
            canSubmit: gameServer._canSubmitDiceAnswer || false,
            tieActive: gameServer._tieActive || false,
            tieRound: gameServer._tieRound || 0,
            leaderboard: sortedPoints.map(([username, score]) => ({ username, score })),
            totalPlayers: gameServer.wsClients?.get('Quiz')?.size || 0,
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get dice status' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // GET RECORDING STATUS
      if (pathname === "/api/recording/status") {
        const roomName = url.searchParams.get('room');
        if (!roomName) {
          return new Response(JSON.stringify({ error: 'Room name required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        if (!gameServer || gameServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Game server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const isRecording = await gameServer._getRecordingStatusFromKV(roomName);
          const winners = await gameServer._getLowCardWinners(roomName);
          
          return new Response(JSON.stringify({
            success: true,
            room: roomName,
            recording: isRecording,
            winners: winners,
            totalWinners: Object.keys(winners).length,
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get recording status' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // GET LOWCARD WINNERS
      if (pathname === "/api/game/winners") {
        const roomName = url.searchParams.get('room');
        if (!roomName) {
          return new Response(JSON.stringify({ error: 'Room name required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        if (!gameServer || gameServer.isDestroyed) {
          return new Response(JSON.stringify({ error: 'Game server not available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        try {
          const isRecording = await gameServer._getRecordingStatusFromKV(roomName);
          const winners = await gameServer._getLowCardWinners(roomName);
          
          return new Response(JSON.stringify({
            success: true,
            room: roomName,
            recording: isRecording,
            winners: winners,
            totalWinners: Object.keys(winners).length,
            timestamp: Date.now()
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            }
          });
        } catch (error) {
          console.error('❌ API error:', error);
          return new Response(JSON.stringify({ error: 'Failed to get winners' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // ==================== HEALTH CHECK ====================
      if (pathname === "/health") {
        const chatStatus = chatServer && !chatServer.isDestroyed ? 'active' : 'inactive';
        const gameStatus = gameServer && !gameServer.isDestroyed ? 'active' : 'inactive';
        let dbStatus = 'unknown';
        
        if (chatServer && chatServer.db) {
          try {
            const result = await chatServer.db.db.prepare('SELECT 1').first();
            dbStatus = result ? 'connected' : 'error';
          } catch (e) {
            dbStatus = 'disconnected';
          }
        }
        
        let gameDbStatus = 'unknown';
        if (gameServer && gameServer.db) {
          try {
            const result = await gameServer.db.db.prepare('SELECT 1').first();
            gameDbStatus = result ? 'connected' : 'error';
          } catch (e) {
            gameDbStatus = 'disconnected';
          }
        }
        
        return new Response(JSON.stringify({
          status: 'ok',
          services: {
            chat: chatStatus,
            game: gameStatus,
            database: dbStatus,
            gameDatabase: gameDbStatus
          },
          initialized: isInitialized,
          timestamp: Date.now(),
          uptime: process.uptime ? Math.floor(process.uptime()) : null,
          chatRooms: chatServer?.ROOMS?.length || 0,
          gameRooms: gameServer?.GAME_ROOMS?.length || 0,
          connections: {
            chat: chatServer?.wsSet?.size || 0,
            game: gameServer?.wsMap?.size || 0
          },
          gameDetails: {
            activeGames: gameServer?.activeGames?.size || 0,
            diceActive: !!gameServer?.currentDiceRoll,
            diceRound: gameServer?._diceRound || 0,
            tieActive: gameServer?._tieActive || false
          }
        }), {
          status: 200,
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          }
        });
      }
      
      // ==================== ROOT - Info server ====================
      return new Response(JSON.stringify({
        name: 'Chat & Game Server',
        version: '2.0.0',
        type: 'D1 Database + KV Storage - No Durable Objects',
        architecture: {
          chat: 'D1 Database for state + WebSocket',
          game: 'D1 Database for state + KV Storage for points + WebSocket'
        },
        endpoints: {
          chat: {
            websocket: '/ws',
            chat: '/chat',
            root: '/'
          },
          game: {
            websocket: '/game/ws',
            game: '/game'
          },
          api: {
            chatRooms: '/api/rooms',
            onlineUsers: '/api/users',
            gameRooms: '/api/game/rooms',
            gamePlayers: '/api/game/players?room=RoomName',
            diceStatus: '/api/dice/status',
            recordingStatus: '/api/recording/status?room=RoomName',
            gameWinners: '/api/game/winners?room=RoomName'
          },
          health: '/health'
        },
        chatRooms: [
          "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", 
          "Birthday Party", "Sweet Memories", "Lounge Talk", 
          "Noxxeliverothcifsa", "BESTIES", "Happy Vibes", "The Chatter Room"
        ],
        gameRooms: [
          "Quiz", "Gacor", "LowCard", "General"
        ],
        diceSchedule: [
          "1:00-2:00 WITA",
          "14:00-15:00 WITA",
          "22:00-23:00 WITA"
        ],
        maxSeats: 45,
        maxPlayers: 45,
        timestamp: Date.now()
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
      });
      
    } catch(error) {
      console.error('❌ Fatal error:', error);
      
      return new Response(JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        stack: error.stack,
        timestamp: Date.now()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // ==================== CLEANUP ====================
  async cleanup() {
    console.log('🔄 Cleaning up...');
    
    if (chatServer && !chatServer.isDestroyed) {
      try { 
        await chatServer.destroy(); 
        console.log('✅ ChatServer destroyed');
      } catch(e) {
        console.error('❌ Error destroying ChatServer:', e);
      }
    }
    chatServer = null;
    
    if (gameServer && !gameServer.isDestroyed) {
      try { 
        await gameServer.destroy(); 
        console.log('✅ GameServer destroyed');
      } catch(e) {
        console.error('❌ Error destroying GameServer:', e);
      }
    }
    gameServer = null;
    
    isInitialized = false;
    console.log('✅ Cleanup complete');
  },
  
  // ==================== WEBSOCKET HANDLERS ====================
  async webSocketMessage(ws, message) {
    // Handle chat messages
    if (chatServer && !chatServer.isDestroyed) {
      try {
        await chatServer.webSocketMessage(ws, message);
        return;
      } catch(e) {
        console.error('❌ Chat WebSocket message error:', e);
      }
    }
    
    // Handle game messages
    if (gameServer && !gameServer.isDestroyed) {
      try {
        await gameServer.webSocketMessage(ws, message);
        return;
      } catch(e) {
        console.error('❌ Game WebSocket message error:', e);
      }
    }
  },
  
  async webSocketClose(ws) {
    if (chatServer && !chatServer.isDestroyed) {
      try {
        await chatServer.webSocketClose(ws);
      } catch(e) {
        console.error('❌ Chat WebSocket close error:', e);
      }
    }
    
    if (gameServer && !gameServer.isDestroyed) {
      try {
        await gameServer.webSocketClose(ws);
      } catch(e) {
        console.error('❌ Game WebSocket close error:', e);
      }
    }
  },
  
  async webSocketError(ws) {
    if (chatServer && !chatServer.isDestroyed) {
      try {
        await chatServer.webSocketError(ws);
      } catch(e) {
        console.error('❌ Chat WebSocket error:', e);
      }
    }
    
    if (gameServer && !gameServer.isDestroyed) {
      try {
        await gameServer.webSocketError(ws);
      } catch(e) {
        console.error('❌ Game WebSocket error:', e);
      }
    }
  }
};

// ==================== EXPORTS ====================
export { ChatServer, GameServer };
