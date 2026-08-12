// ==================== INDEX.JS - TANPA DURABLE OBJECTS ====================
import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

let chatServer = null;
let gameServer = null;
let isInitialized = false;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // ✅ INISIALISASI DI AWAL
      if (!isInitialized) {
        try {
          chatServer = new ChatServer(env);
          gameServer = new GameServer(env);
          if (gameServer._initAsync) {
            await gameServer._initAsync();
          }
          isInitialized = true;
        } catch(e) {
          // Gagal init, akan dicoba lagi nanti
        }
      }
      
      if (pathname === "/ws" || pathname === "/chat" || pathname === "/") {
        if (!chatServer || chatServer.isDestroyed) {
          chatServer = new ChatServer(env);
        }
        return chatServer.fetch(request);
      }
      
      if (pathname === "/game/ws" || pathname === "/game") {
        if (!gameServer || gameServer.isDestroyed) {
          gameServer = new GameServer(env);
          if (gameServer._initAsync) {
            await gameServer._initAsync();
          }
        }
        return gameServer.fetch(request);
      }
      
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
      
      return new Response("Server running - Use /ws for chat or /game/ws for game", {
        status: 200,
        headers: { 
          "Content-Type": "text/plain",
          "Cache-Control": "no-cache"
        }
      });
      
    } catch(error) {
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
  
  async cleanup() {
    if (chatServer && !chatServer.isDestroyed) {
      try { await chatServer.destroy(); } catch(e) {}
    }
    chatServer = null;
    
    if (gameServer && !gameServer.isDestroyed) {
      try { await gameServer.destroy(); } catch(e) {}
    }
    gameServer = null;
    
    isInitialized = false;
  }
};

export { ChatServer, GameServer };
