import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

export { ChatServer, GameServer };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 🔥 CEK WEBSOCKET DULU (SEBELUM ROUTING KE GAME)
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === "websocket") {
      // WebSocket selalu ke CHAT SERVER
      const id = env.CHAT_SERVER.idFromName("main");
      const obj = env.CHAT_SERVER.get(id);
      return obj.fetch(request);
    }
    
    // 🔥 GAME SERVER - handle /game/* (HANYA HTTP, BUKAN WEBSOCKET)
    if (path.startsWith("/game")) {
      const id = env.GAME_SERVER.idFromName("main");
      const obj = env.GAME_SERVER.get(id);
      return obj.fetch(request);
    }
    
    // 🔥 CHAT SERVER - handle SEMUA yang lain
    const id = env.CHAT_SERVER.idFromName("main");
    const obj = env.CHAT_SERVER.get(id);
    return obj.fetch(request);
  }
};
