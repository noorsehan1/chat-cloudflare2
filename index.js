import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

export { ChatServer, GameServer };

// ✅ RATE LIMITER & DDOS PROTECTION
const RATE_LIMIT = {
  windowMs: 60000,        // 1 menit
  maxRequests: 60,        // max 60 request per menit
  burstLimit: 10,         // max 10 request per detik
  burstWindowMs: 1000,    // 1 detik
};

// ✅ INI BOLEH DI GLOBAL SCOPE (hanya deklarasi Map)
const rateLimitTracker = new Map();

// ✅ FUNGSI INI BOLEH DI GLOBAL SCOPE
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitTracker.get(ip);
  
  if (!record) {
    rateLimitTracker.set(ip, {
      count: 1,
      burstCount: 1,
      windowStart: now,
      burstStart: now,
    });
    return true;
  }
  
  // CEK BURST (1 DETIK)
  if ((now - record.burstStart) <= RATE_LIMIT.burstWindowMs) {
    if (record.burstCount >= RATE_LIMIT.burstLimit) {
      return false;
    }
    record.burstCount++;
  } else {
    record.burstCount = 1;
    record.burstStart = now;
  }
  
  // CEK RATE LIMIT (1 MENIT)
  if ((now - record.windowStart) <= RATE_LIMIT.windowMs) {
    if (record.count >= RATE_LIMIT.maxRequests) {
      return false;
    }
    record.count++;
  } else {
    record.count = 1;
    record.windowStart = now;
  }
  
  return true;
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

// ✅ CLEANUP DILAKUKAN DI DALAM REQUEST (BUKAN SETINTERVAL)
function cleanupRateLimiter() {
  const now = Date.now();
  for (const [ip, record] of rateLimitTracker) {
    if ((now - record.windowStart) > RATE_LIMIT.windowMs) {
      rateLimitTracker.delete(ip);
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      // ✅ CLEANUP DI SETIAP REQUEST (10% CHANCE)
      if (Math.random() < 0.1) {
        cleanupRateLimiter();
      }
      
      const url = new URL(request.url);
      const path = url.pathname;
      
      // DDOS PROTECTION - CEK RATE LIMIT
      const ip = getClientIP(request);
      if (!checkRateLimit(ip)) {
        return new Response("Too many requests. Please wait.", { 
          status: 429,
          headers: { 
            "Retry-After": "60",
            "Content-Type": "text/plain"
          }
        });
      }
      
      // CEK APAKAH WEBSOCKET?
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("WebSocket only", { 
          status: 400,
          headers: { "Content-Type": "text/plain" }
        });
      }
      
      // ROUTE: GAME SERVER
      if (path === "/game/ws") {
        const id = env.GAME_SERVER.idFromName("main");
        const obj = env.GAME_SERVER.get(id);
        return obj.fetch(request);
      }
      
      // DEFAULT: CHAT SERVER
      const id = env.CHAT_SERVER.idFromName("main");
      const obj = env.CHAT_SERVER.get(id);
      return obj.fetch(request);
      
    } catch(error) {
      return new Response("Internal Server Error", { 
        status: 500,
        headers: { "Content-Type": "text/plain" }
      });
    }
  }
};
