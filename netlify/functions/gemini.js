// Rate limiting store (in-memory, resets on cold start)
const rateLimitStore = new Map();

const RATE_LIMITS = {
  perIP: { requests: 10, windowMs: 15 * 60 * 1000 }, // 10 requests per 15 minutes per IP
  global: { requests: 1000, windowMs: 60 * 60 * 1000 } // 1000 requests per hour globally
};

function checkRateLimit(ip) {
  const now = Date.now();
  
  // Check IP rate limit
  const ipKey = `ip:${ip}`;
  const ipData = rateLimitStore.get(ipKey) || { count: 0, resetTime: now + RATE_LIMITS.perIP.windowMs };
  
  if (now > ipData.resetTime) {
    ipData.count = 0;
    ipData.resetTime = now + RATE_LIMITS.perIP.windowMs;
  }
  
  if (ipData.count >= RATE_LIMITS.perIP.requests) {
    return { allowed: false, retryAfter: Math.ceil((ipData.resetTime - now) / 1000) };
  }
  
  ipData.count++;
  rateLimitStore.set(ipKey, ipData);
  
  return { allowed: true };
}

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': 'https://medextractai.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Rate limiting
  const clientIP = event.headers['x-forwarded-for'] || event.headers['x-nf-client-connection-ip'] || 'unknown';
  const rateCheck = checkRateLimit(clientIP);
  
  if (!rateCheck.allowed) {
    return {
      statusCode: 429,
      headers: { ...headers, 'Retry-After': rateCheck.retryAfter },
      body: JSON.stringify({ error: `Too many requests. Try again in ${rateCheck.retryAfter} seconds.` })
    };
  }

  try {
    const { prompt } = JSON.parse(event.body);
    
    if (!prompt || typeof prompt !== 'string' || prompt.length > 10000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid prompt. Must be a string under 10000 characters.' })
      };
    }

    // Call Google Gemini API
    const API_KEY = process.env.GEMINI_API_KEY;
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${API_KEY}`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.candidates && result.candidates.length > 0 &&
        result.candidates[0].content && result.candidates[0].content.parts &&
        result.candidates[0].content.parts.length > 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          text: result.candidates[0].content.parts[0].text 
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        text: 'Sorry, the AI could not generate a response.' 
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
