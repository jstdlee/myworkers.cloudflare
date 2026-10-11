addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
  })
  
  async function handleRequest(request) {
    // 认证逻辑保持不变
    // Set CHAT_USERNAME, CHAT_PASSWORD and DIFY_CHATBOT_URL as Worker secrets/variables.
    if (typeof CHAT_USERNAME === 'undefined' || typeof CHAT_PASSWORD === 'undefined' || typeof DIFY_CHATBOT_URL === 'undefined') {
      return new Response('Worker is not configured', { status: 500 })
    }
    const USERNAME = CHAT_USERNAME
    const PASSWORD = CHAT_PASSWORD
  
    const authorization = request.headers.get('Authorization')
  
    if (!authorization) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Enter username and password"',
          'Content-Type': 'text/plain'
        }
      })
    }
  
    const [scheme, encoded] = authorization.split(' ')
    if (!encoded || scheme !== 'Basic') {
      return new Response('Invalid authorization format', { status: 400 })
    }
  
    const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const decoded = new TextDecoder().decode(buffer).normalize()
    const [username, password] = decoded.split(':')
  
    if (username !== USERNAME || password !== PASSWORD) {
      return new Response('Invalid username or password', { status: 401 })
    }
  
    // 更新的 HTML 内容
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>My OFS IB tutor</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
          }
          .container {
            max-width: 800px;
            width: 100%;
            margin: 0 auto;
            padding: 20px;
            box-sizing: border-box;
          }
          .content {
            background-color: #fff;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          h1 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
            margin-top: 0;
          }
          .intro {
            font-size: 16px;
            color: #34495e;
            margin-bottom: 20px;
          }
          .feature {
            background-color: #ecf0f1;
            border-left: 4px solid #3498db;
            padding: 15px;
            margin-bottom: 20px;
          }
          .feature h2 {
            margin-top: 0;
            color: #2980b9;
          }
          iframe {
            width: 100%;
            height: 700px;
            border: none;
          }
          @media (max-width: 600px) {
            .container {
              padding: 10px;
            }
            .content {
              padding: 15px;
            }
            h1 {
              font-size: 24px;
            }
            .intro {
              font-size: 14px;
            }
            iframe {
              height: 500px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <h1>Welcome to this tutor</h1>
            <p class="intro">
              This page is served by Cloudflare and Dify, demonstrating the power (illustration) and flexibility (diffusion) of LLM tutor (in other words, AIGC).
            </p>
            <iframe
              src="${DIFY_CHATBOT_URL}"
              allow="microphone">
            </iframe>
  
            <div class="feature">
              <p>
                This tutor is an interactive learning tutor, so please be patient. Learn and discover knowledge through guidance and interesting thoughts, not just answers (the most boring portion). You can use speech-to-text if you don't want to type.
              </p>
            </div>          
          </div>
        </div>
      </body>
      </html>
    `
  
    return new Response(html, {
      headers: {
        'content-type': 'text/html;charset=UTF-8',
      },
    })
  }