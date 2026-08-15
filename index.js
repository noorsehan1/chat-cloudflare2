// ==================== INDEX.JS - FIXED & OPTIMIZED ====================
import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

// ==================== EKSPOR DURABLE OBJECTS ====================
export { ChatServer, GameServer };

// ==================== FETCH HANDLER ====================
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // === ROUTING ===
      
      // 1. CHAT SERVER
      if (pathname === "/ws" || pathname === "/chat" || pathname === "/") {
        const id = env.CHAT_SERVER.idFromName("global");
        const obj = env.CHAT_SERVER.get(id);
        return obj.fetch(request);
      }
      
      // 2. GAME SERVER - WebSocket
      if (pathname === "/game/ws") {
        const id = env.GAME_SERVER.idFromName("game");
        const obj = env.GAME_SERVER.get(id);
        return obj.fetch(request);
      }
      
      // 3. GAME SERVER - Health Check
      if (pathname === "/game/health") {
        try {
          const id = env.GAME_SERVER.idFromName("game");
          const obj = env.GAME_SERVER.get(id);
          return obj.fetch(request);
        } catch(e) {
          return new Response(JSON.stringify({
            status: "degraded",
            error: "Game server not available",
            timestamp: Date.now()
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // 4. GAME SERVER - Status
      if (pathname === "/game" || pathname === "/game/status") {
        return new Response(JSON.stringify({
          name: "Game Server",
          status: "online",
          version: "3.0.0",
          endpoints: {
            websocket: "/game/ws",
            health: "/game/health"
          },
          timestamp: Date.now()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 5. ROOT - Server Info
      if (pathname === "/" || pathname === "") {
        return new Response(JSON.stringify({
          name: "Chat Cloudflare Server",
          version: "3.0.0",
          status: "online",
          services: {
            chat: {
              endpoint: "/ws",
              description: "Chat WebSocket"
            },
            game: {
              endpoint: "/game/ws",
              health: "/game/health",
              description: "Game WebSocket"
            }
          },
          timestamp: Date.now()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 6. 404 - Not Found
      return new Response(JSON.stringify({
        error: "Not Found",
        path: pathname,
        timestamp: Date.now()
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch(e) {
      // === ERROR HANDLING ===
      console.error("Worker error:", e);
      
      return new Response(JSON.stringify({
        error: "Internal Server Error",
        message: e.message,
        stack: e.stack,
        timestamp: Date.now()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
