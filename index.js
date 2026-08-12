// ==================== INDEX.JS - TANPA DURABLE OBJECTS ====================
import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

// ✅ INSTANCE GLOBAL (Reuse untuk semua request)
let chatServer = null;
let gameServer = null;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // ==================== CHAT ROUTES ====================
      // ✅ CHAT: /ws, /chat, atau /
      if (pathname === "/ws" || pathname === "/chat" || pathname === "/") {
        // Buat atau reuse ChatServer
        if (!chatServer || chatServer.isDestroyed) {
          chatServer = new ChatServer(env);
        }
        return chatServer.fetch(request);
      }
      
      // ==================== GAME ROUTES ====================
      // ✅ GAME: /game/ws atau /game
      if (pathname === "/game/ws" || pathname === "/game") {
        // Buat atau reuse GameServer
        if (!gameServer || gameServer.isDestroyed) {
          gameServer = new GameServer(env);
          // Init async jika ada
          if (gameServer._initAsync) {
            await gameServer._initAsync();
          }
        }
        return gameServer.fetch(request);
      }
      
      // ==================== HEALTH CHECK ====================
      // ✅ HEALTH: /health
      if (pathname === "/health") {
        return new Response(JSON.stringify({
          status: "ok",
          chat: chatServer && !chatServer.isDestroyed ? "active" : "inactive",
          game: gameServer && !gameServer.isDestroyed ? "active" : "inactive",
          timestamp: Date.now()
        }), {
          status: 200,
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-cache"
          }
        });
      }
      
      // ==================== ROOT ====================
      return new Response("Server running - Use /ws for chat or /game/ws for game", {
        status: 200,
        headers: { 
          "Content-Type": "text/plain",
          "Cache-Control": "no-cache"
        }
      });
      
    } catch(error) {
      console.error('[Worker] Error:', error);
      return new Response(JSON.stringify({
        error: "Internal server error",
        message: error.message,
        timestamp: Date.now()
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },
  
  // ==================== CLEANUP ====================
  // ✅ DIPANGGIL SAAT WORKER DIHENTIKAN
  async cleanup() {
    console.log('[Worker] Cleaning up...');
    
    // Cleanup ChatServer
    if (chatServer && !chatServer.isDestroyed) {
      try {
        await chatServer.destroy();
        console.log('[Worker] ChatServer destroyed');
      } catch(e) {
        console.error('[Worker] ChatServer destroy error:', e);
      }
    }
    chatServer = null;
    
    // Cleanup GameServer
    if (gameServer && !gameServer.isDestroyed) {
      try {
        await gameServer.destroy();
      } catch(e) {
      }
    }
    gameServer = null;
    
    console.log('[Worker] Cleanup completed');
  }
};

// ✅ EKSPOR CLASS UNTUK MIGRASI (jika diperlukan)
export { ChatServer, GameServer };
