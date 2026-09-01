import { ChatServer } from './src/chat-server.js';
import { GameServer } from './src/game-server.js';

export { ChatServer, GameServer };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle WebSocket upgrade requests
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      // Route to chat server for WebSocket connections
      const id = env.CHAT_SERVER.idFromName('default');
      const stub = env.CHAT_SERVER.get(id);
      return stub.fetch(request);
    }
    
    // Route regular HTTP requests
    if (path.startsWith('/chat')) {
      const id = env.CHAT_SERVER.idFromName('default');
      const stub = env.CHAT_SERVER.get(id);
      return stub.fetch(request);
    }
    
    if (path.startsWith('/game')) {
      const id = env.GAME_SERVER.idFromName('default');
      const stub = env.GAME_SERVER.get(id);
      return stub.fetch(request);
    }
    
    if (path.startsWith('/api/questions')) {
      return handleQuizRequest(request, env);
    }
    
    // Health check endpoint
    if (path === '/health') {
      return new Response('OK', { 
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
};

async function handleQuizRequest(request, env) {
  const url = new URL(request.url);
  const questionId = url.searchParams.get('id');
  
  if (questionId) {
    const question = await env.QUESTIONS.get(questionId, 'json');
    return Response.json(question || { error: 'Question not found' });
  }
  
  // Get all questions
  const keys = await env.QUESTIONS.list();
  const questions = await Promise.all(
    keys.keys.map(async (key) => ({
      id: key.name,
      data: await env.QUESTIONS.get(key.name, 'json')
    }))
  );
  
  return Response.json(questions);
}
