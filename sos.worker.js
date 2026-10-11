// Configuration
const CONFIG = {
    DEFAULT_CHANNEL: 'CHANGE-ME-random-topic',
    MAX_REQUESTS_PER_MINUTE: 20,
    MESSAGE_HISTORY_LIMIT: 50  // Changed from 10 to 50
  }
  
  // Simple in-memory rate limiting
  const ipRequests = new Map()
  
  addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
  })
  
  async function handleRequest(request) {
    const ip = request.headers.get('CF-Connecting-IP')
    if (isRateLimited(ip)) {
      return new Response('Rate limit exceeded. Please try again later.', { status: 429 })
    }
  
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(part => part)
  
    try {
      if (parts.length === 0) {
        return await displayLatestMessages()
      } else if (parts.length === 2 && parts[0] === 'send') {
        const message = decodeURIComponent(parts[1])
        return await sendMessage(CONFIG.DEFAULT_CHANNEL, message)
      } else {
        return new Response('Invalid request. Use / for latest messages, /send/{message} to send a message, or /messages to send and redirect', { status: 400 })
      }
    } catch (error) {
      console.error('Error:', error)
      return new Response('An error occurred. Please try again later.', { status: 500 })
    }
  }
  
  function isRateLimited(ip) {
    const now = Date.now()
    const recentRequests = ipRequests.get(ip) || []
    const recentRequestsInWindow = recentRequests.filter(time => now - time < 60000)
    
    if (recentRequestsInWindow.length >= CONFIG.MAX_REQUESTS_PER_MINUTE) {
      return true
    }
  
    recentRequestsInWindow.push(now)
    ipRequests.set(ip, recentRequestsInWindow)
    return false
  }
  
  async function sendMessage(channel, message) {
    console.log(`Sending message to ${channel}: ${message}`)
  
    const ntfyUrl = `https://ntfy.sh/${channel}`
    const emojis = [
      '😊', '👍', '🙏', '🤩', '🎉', '👏', '😄', '😃', '😆', '😎',
      '🤝', '💕', '😍', '😘', '😗', '😙', '😚', '😛', '😝',
      '😹', '😺', '😻', '😼', '😽', '😾'
    ]
    const emoji = emojis[Math.floor(Math.random() * emojis.length)]
    const ntfyData = `${emoji}: ${message}`
    const ntfyHeaders = {}
    const response = await fetch(ntfyUrl, {
      method: 'POST',
      body: ntfyData,
      headers: ntfyHeaders,
    })
  
    if (response.status === 200) {
      return displayLatestMessages()
    } else {
      throw new Error('Failed to send message')
    }
  }
  
  async function displayLatestMessages() {
    const ntfyUrl = `https://ntfy.sh/${CONFIG.DEFAULT_CHANNEL}/json?poll=1`
    const response = await fetch(ntfyUrl)
  
    if (response.ok) {
      const text = await response.text()
      const messages = text
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
          try {
            return JSON.parse(line)
          } catch (e) {
            console.error('Failed to parse JSON line:', line)
            return null
          }
        })
        .filter(msg => msg !== null)
        .sort((a, b) => b.time - a.time)  // Sort messages by time, newest first
        .slice(0, CONFIG.MESSAGE_HISTORY_LIMIT)  // Take only the latest 50 messages
  
      if (messages.length === 0) {
        return new Response('No messages found', { status: 200 })
      }
  
      return generateMessagesHTML(messages)
    } else {
      throw new Error('Failed to fetch messages')
    }
  }
  
  function generateMessagesHTML(messages) {
    const messageList = messages.map(msg => {
      const date = new Date(msg.time * 1000);
      const sgTime = date.toLocaleString('en-US', { timeZone: 'Asia/Singapore' });
      return `
      <li>
        ${msg.title ? msg.title + ': ' : ''}${msg.message}
        (${sgTime})
      </li>
    `}).join('')
  
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <title>Messages - ${CONFIG.DEFAULT_CHANNEL}</title>
      </head>
      <body>
          <h1>WARNING: </h1>
          <p>this is a public channel, do NOT use this for sensitive information</p>
          <h1>How to send a message:</h1>
          <p>Edit your browser address bar to /send/{message} and Send a message</p>
          <h1>Messages at channel ${CONFIG.DEFAULT_CHANNEL}</h1>
          <ul>
              ${messageList}
          </ul>
      </body>
      </html>
    `
    
    return new Response(html, {
      headers: {
        'content-type': 'text/html;charset=UTF-8',
      },
    })
  }