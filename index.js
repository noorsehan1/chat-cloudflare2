import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

export { ChatServer, GameServer };

// ✅ BARU: Rate limiter untuk mencegah spam
const RATE_LIMIT = {
  windowMs: 60000, // 1 menit
  maxRequests: 60, // 60 request per menit per IP
};

// ✅ BARU: Simple in-memory rate limiter (hanya untuk preview)
// Untuk production, gunakan KV atau Durable Object
const rateLimiter = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimiter.get(ip);
  
  if (!record || (now - record.timestamp) > RATE_LIMIT.windowMs) {
    rateLimiter.set(ip, { count: 1, timestamp: now });
    return true;
  }
  
  if (record.count >= RATE_LIMIT.maxRequests) {
    return false;
  }
  
  record.count++;
  return true;
}

// ✅ BARU: Cleanup rate limiter setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimiter) {
    if ((now - record.timestamp) > RATE_LIMIT.windowMs) {
      rateLimiter.delete(ip);
    }
  }
}, 300000);

// ✅ BARU: Get client IP dengan aman
function getClientIP(request) {
  try {
    return request.headers.get("CF-Connecting-IP") ||
           request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ||
           request.headers.get("X-Real-IP") ||
           "unknown";
  } catch(e) {
    return "unknown";
  }
}

// ✅ BARU: Cek apakah path valid
function isValidPath(path) {
  const validPaths = ["/game/ws", "/chat/ws", "/"];
  return validPaths.includes(path);
}

export default {
  async fetch(request, env) {
    // ✅ CEK METHOD
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Upgrade",
        },
      });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // ✅ VALIDASI PATH
      if (!isValidPath(path)) {
        return new Response("Not Found", { status: 404 });
      }
      
      // ✅ RATE LIMITING (kecuali untuk WebSocket upgrade)
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        const ip = getClientIP(request);
        if (!checkRateLimit(ip)) {
          return new Response("Rate limit exceeded. Please wait.", { 
            status: 429,
            headers: {
              "Retry-After": "60",
              "Access-Control-Allow-Origin": "*",
            }
          });
        }
        
        // ✅ RESPONSE CACHE untuk root path
        if (path === "/") {
          return new Response("Chat & Game Server", {
            status: 200,
            headers: {
              "Cache-Control": "public, max-age=300",
              "Access-Control-Allow-Origin": "*",
            }
          });
        }
      }
      
      // ✅ HANYA WEBSOCKET
      if (upgrade !== "websocket") {
        return new Response("WebSocket only", { 
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
          }
        });
      }
      
      // ✅ ROUTING KE DO
      if (path === "/game/ws") {
        // ✅ Gunakan room name dari query parameter untuk load balancing
        const room = url.searchParams.get("room") || "main";
        const id = env.GAME_SERVER.idFromName(room);
        const obj = env.GAME_SERVER.get(id);
        return obj.fetch(request);
      }
      
      // ✅ DEFAULT: CHAT SERVER
      // ✅ Gunakan room name dari query parameter untuk load balancing
      const room = url.searchParams.get("room") || "main";
      const id = env.CHAT_SERVER.idFromName(room);
      const obj = env.CHAT_SERVER.get(id);
      return obj.fetch(request);
      
    } catch(error) {
      // ✅ ERROR HANDLING
      console.error("Server error:", error);
      return new Response("Internal Server Error", { 
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        }
      });
    }
  },
  
  // ✅ BARU: Scheduled cleanup
  async scheduled(event, env, ctx) {
    try {
      // Cleanup rate limiter
      const now = Date.now();
      for (const [ip, record] of rateLimiter) {
        if ((now - record.timestamp) > RATE_LIMIT.windowMs) {
          rateLimiter.delete(ip);
        }
      }
    } catch(e) {
      console.error("Scheduled cleanup error:", e);
    }
  }
};
