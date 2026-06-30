import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

export { ChatServer, GameServer };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 🔥 CEK APAKAH WEBSOCKET?
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      // BUKAN WEBSOCKET -> TOLAK
      return new Response("WebSocket only", { 
        status: 400,
        headers: { "Content-Type": "text/plain" }
      });
    }
    
    // 🔥 CEK PATH UNTUK GAME ATAU CHAT
    if (path === "/game/ws") {
      // GAME - WSS
      const id = env.GAME_SERVER.idFromName("main");
      const obj = env.GAME_SERVER.get(id);
      return obj.fetch(request);
    }
    
    // CHAT - WSS (DEFAULT)
    const id = env.CHAT_SERVER.idFromName("main");
    const obj = env.CHAT_SERVER.get(id);
    return obj.fetch(request);
  }
};
