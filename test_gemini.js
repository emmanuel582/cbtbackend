/**
 * Diagnostic test with global fetch monkey-patch
 */
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Monkey patch global fetch to bypass DNS issues for generativelanguage.googleapis.com
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(url instanceof Request ? url.url : url);
  } catch (e) {
    return originalFetch(url, options);
  }
  
  if (parsedUrl.hostname === 'generativelanguage.googleapis.com') {
    parsedUrl.hostname = '216.239.38.223'; // Hardcoded IP from 8.8.8.8
    
    if (!options) options = {};
    if (!options.headers) {
      options.headers = {};
    }
    
    // Convert Headers object or attach Host directly
    if (options.headers instanceof Headers) {
      options.headers.set('Host', 'generativelanguage.googleapis.com');
    } else {
      options.headers['Host'] = 'generativelanguage.googleapis.com';
    }
  }
  
  return originalFetch(parsedUrl.toString(), options);
};

async function test() {
  console.log('Testing Gemini API connectivity with global fetch patch...');
  
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  try {
    const result = await model.generateContent('Say hello in one word.');
    console.log('✓ Response:', result.response.text());
  } catch (err) {
    console.error('✗ Test failed:', err.message);
  }
}

test();
