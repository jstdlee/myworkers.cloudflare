"use strict";
(() => {
  // src/index.ts
  const CONFIG = {
    urls: [
      { url: "https://example.com/" },
      { url: "https://status.example.com/" },
      {
        url: "https://private.example.com/",
        auth: { username: "username", password: "change-me" }
      },
    ],
    ntfyURL: "https://ntfy.sh/CHANGE-ME-random-topic",
    refreshInterval: 300, // 5 minutes in seconds
  };

  addEventListener("scheduled", (event) => {
    event.waitUntil(handleScheduledEvent());
  });

  addEventListener("fetch", (event) => {
    if (event.request.url.endsWith("/")) {
      event.respondWith(handleDashboardRequest());
    } else {
      event.respondWith(handleFetchRequest(event.request));
    }
  });

  function getDomainFromURL(url) {
    try {
      const domain = new URL(url).hostname;
      return domain;
    } catch (e) {
      return url;
    }
  }

  async function checkService(service) {
    const options = {};
    if (service.auth) {
      const credentials = btoa(`${service.auth.username}:${service.auth.password}`);
      options.headers = {
        'Authorization': `Basic ${credentials}`
      };
    }

    try {
      const response = await fetch(service.url, options);
      return {
        serviceUrl: service.url,
        domain: getDomainFromURL(service.url),
        status: response.status,
        checkedTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' })
      };
    } catch (error) {
      return {
        serviceUrl: service.url,
        domain: getDomainFromURL(service.url),
        status: 'error',
        checkedTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' })
      };
    }
  }

  async function handleDashboardRequest() {
    const results = await Promise.all(CONFIG.urls.map(checkService));

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Service Uptime Status</title>
          <style>
              :root {
                  --bg-color: #ffffff;
                  --text-color: #1d1d1f;
                  --secondary-text: #86868b;
                  --success-color: #00a854;
                  --error-color: #ff3b30;
                  --card-bg: #fbfbfd;
                  --border-color: #f5f5f7;
              }
              
              @media (prefers-color-scheme: dark) {
                  :root {
                      --bg-color: #000000;
                      --text-color: #f5f5f7;
                      --secondary-text: #86868b;
                      --success-color: #2ed158;
                      --error-color: #ff453a;
                      --card-bg: #1d1d1f;
                      --border-color: #2d2d2d;
                  }
              }

              * {
                  margin: 0;
                  padding: 0;
                  box-sizing: border-box;
                  -webkit-font-smoothing: antialiased;
              }

              body {
                  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Icons", "Helvetica Neue", Helvetica, Arial, sans-serif;
                  background: var(--bg-color);
                  color: var(--text-color);
                  line-height: 1.47059;
                  font-weight: 400;
                  letter-spacing: -0.022em;
              }

              .container {
                  max-width: 980px;
                  margin: 0 auto;
                  padding: 40px 20px;
              }

              h1 {
                  font-size: 48px;
                  line-height: 1.08349;
                  font-weight: 600;
                  letter-spacing: -0.003em;
                  text-align: center;
                  margin-bottom: 20px;
              }

              .hero-message {
                  font-size: 24px;
                  text-align: center;
                  color: var(--text-color);
                  margin-bottom: 8px;
              }

              .sub-hero-message {
                  font-size: 14px;
                  text-align: center;
                  color: var(--secondary-text);
                  margin-bottom: 40px;
                  font-weight: 400;
              }

              .services-grid {
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                  gap: 20px;
                  margin-top: 30px;
                  margin-bottom: 60px;
              }

              .service-card {
                  background: var(--card-bg);
                  border-radius: 18px;
                  padding: 24px;
                  transition: transform 0.3s ease;
              }

              .service-card:hover {
                  transform: scale(1.02);
              }

              .service-title {
                  font-size: 20px;
                  font-weight: 600;
                  margin-bottom: 12px;
              }

              .service-title a {
                  color: var(--text-color);
                  text-decoration: none;
              }

              .service-title a:hover {
                  text-decoration: underline;
              }

              .status {
                  display: flex;
                  align-items: center;
                  gap: 8px;
                  font-size: 14px;
                  margin: 8px 0;
              }

              .status-indicator {
                  width: 8px;
                  height: 8px;
                  border-radius: 50%;
              }

              .operational .status-indicator {
                  background: var(--success-color);
              }

              .disrupted .status-indicator {
                  background: var(--error-color);
              }

              .time {
                  font-size: 12px;
                  color: var(--secondary-text);
                  margin-top: 12px;
              }

              .footer {
                  border-top: 1px solid var(--border-color);
                  padding-top: 20px;
                  margin-top: auto;
                  font-size: 12px;
                  color: var(--secondary-text);
                  text-align: center;
              }

              .footer p {
                  margin: 4px 0;
              }

              .footer a {
                  color: var(--secondary-text);
                  text-decoration: none;
              }

              .footer a:hover {
                  text-decoration: underline;
              }

              @media (max-width: 734px) {
                  .container {
                      padding: 20px;
                  }
                  
                  h1 {
                      font-size: 40px;
                      margin-bottom: 16px;
                  }

                  .hero-message {
                      font-size: 20px;
                      margin-bottom: 6px;
                  }

                  .sub-hero-message {
                      font-size: 13px;
                      margin-bottom: 30px;
                  }
              }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Service Uptime Status</h1>
              <div class="hero-message">${results.filter(r => r.status === 200 || r.status === 401).length} / ${results.length} Services Operational</div>
              <div class="sub-hero-message">Refresh interval: ${CONFIG.refreshInterval} seconds</div>
              <div class="services-grid">
                  ${results.map(result => `
                      <div class="service-card ${(result.status === 200 || result.status === 401) ? 'operational' : 'disrupted'}">
                          <div class="service-title">
                              <a href="${result.serviceUrl}" target="_blank">${result.domain}</a>
                          </div>
                          <div class="status">
                              <span class="status-indicator"></span>
                              ${(result.status === 200 || result.status === 401) ? 'Operational' : 'Service Disruption'}
                          </div>
                          <div class="time">Last checked: ${result.checkedTime}</div>
                      </div>
                  `).join('')}
              </div>
              <footer class="footer">
                <p><a href="https://github.com/jstdlee/myworkers.cloudflare/issues" target="_blank">Report an issue</a> | &copy; ${new Date().getFullYear()} All rights reserved.</p>
              </footer>
          </div>
      </body>
      </html>
    `;

    return new Response(html, { 
      headers: { 
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      } 
    });
  }

  async function handleScheduledEvent() {
    for (let service of CONFIG.urls) {
      const result = await checkService(service);
      if (result.status !== 200 && result.status !== 401) {
        let msg = JSON.stringify({
          message: `Status: ${result.status}, Service at ${result.serviceUrl} is down.`
        });
        await fetch(CONFIG.ntfyURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: msg
        });
        console.log(`Service at ${result.serviceUrl} is down, notification sent.`);
      } else {
        console.log(`Service at ${result.serviceUrl} is alive`);
      }
    }
  }

  async function handleFetchRequest(request) {
    return new Response("OK", {
      headers: { "content-type": "text/plain" }
    });
  }
})();
