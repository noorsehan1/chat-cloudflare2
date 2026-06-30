import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

export { ChatServer, GameServer };

// ✅ RATE LIMITER (tanpa setInterval global)
const RATE_LIMIT = {
  windowMs: 60000,
  maxRequests: 60,
};

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

// ✅ CLEANUP DI DALAM scheduled handler (BUKAN global)
function cleanupRateLimiter() {
  const now = Date.now();
  for (const [ip, record] of rateLimiter) {
    if ((now - record.timestamp) > RATE_LIMIT.windowMs) {
      rateLimiter.delete(ip);
    }
  }
}

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

function isValidPath(path) {
  const validPaths = ["/game/ws", "/chat/ws", "/", "/health", "/ping"];
  return validPaths.includes(path);
}

// ✅ CORS HEADERS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version",
  "Access-Control-Allow-Credentials": "true",
};

export default {
  async fetch(request, env) {
    // ✅ OPTIONS (CORS preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // ✅ VALIDASI PATH
      if (!isValidPath(path)) {
        return new Response("Not Found", { status: 404 });
      }
      
      // ✅ HEALTH CHECK
      if (path === "/health" || path === "/ping") {
        return new Response(JSON.stringify({
          status: "healthy",
          timestamp: Date.now(),
          rateLimiterSize: rateLimiter.size,
        }), {
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
            "Cache-Control": "no-cache",
          }
        });
      }
      
      // ✅ RATE LIMITING (kecuali WebSocket)
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        const ip = getClientIP(request);
        if (!checkRateLimit(ip)) {
          return new Response("Rate limit exceeded. Please wait.", { 
            status: 429,
            headers: {
              "Retry-After": "60",
              ...CORS_HEADERS,
            }
          });
        }
        
        // ✅ ROOT PATH
        if (path === "/") {
          return new Response("Chat & Game Server Running ✅", {
            status: 200,
            headers: {
              "Cache-Control": "public, max-age=300",
              ...CORS_HEADERS,
            }
          });
        }
      }
      
      // ✅ HANYA WEBSOCKET
      if (upgrade !== "websocket") {
        return new Response("WebSocket only", { 
          status: 400,
          headers: CORS_HEADERS,
        });
      }
      
      // ✅ ROUTING KE DO
      const room = url.searchParams.get("room") || "main";
      
      if (path === "/game/ws") {
        const id = env.GAME_SERVER.idFromName(room);
        const obj = env.GAME_SERVER.get(id);
        return obj.fetch(request);
      }
      
      // ✅ CHAT SERVER (DEFAULT)
      const id = env.CHAT_SERVER.idFromName(room);
      const obj = env.CHAT_SERVER.get(id);
      return obj.fetch(request);
      
    } catch(error) {
      console.error("Server error:", error);
      return new Response("Internal Server Error: " + error.message, { 
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
  
  // ✅ SCHEDULED CLEANUP (BUKAN global setInterval)
  async scheduled(event, env, ctx) {
    try {
      cleanupRateLimiter();
    } catch(e) {
      console.error("Scheduled cleanup error:", e);
    }
  }
};
