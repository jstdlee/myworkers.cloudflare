"use strict";
(() => {
  // src/index.ts
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
  });
  addEventListener("scheduled", (event) => {
    event.waitUntil(handleScheduledCheck());
  });
  var CONFIG = {
    detectorURL: "https://downdetector.sg/",
    ntfyURL: "https://ntfy.sh/CHANGE-ME-random-topic",
    operators: ["Singtel", "Starhub", "M1", "SIMBA", "MyRepublic", "DBS"],
    smaWindow: 20,
    smaRatioThreshold: 5,
    absoluteThreshold: 60
  };
  async function handleRequest(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/":
      case "/dashboard":
        return await renderDashboard();
      case "/cron":
        return await handleScheduledCheck();
      default:
        return await renderDashboard();
    }
  }
  async function handleScheduledCheck() {
    const response = await fetch(CONFIG.detectorURL);
    const text = await response.text();
    const data = extractData(text);
    await evaluateServiceStatus(data);
  }
  function extractData(html) {
    const regex = /<div[^>]*class='[^']*company-card[^']*'[^>]*>[\s\S]*?<h5>(.*?)<\/h5>[\s\S]*?data-values='(\[.*?\])'/g;
    return Array.from(html.matchAll(regex), (match) => ({
      operator: match[1].trim(),
      values: JSON.parse(match[2])
    }));
  }
  async function evaluateServiceStatus(data) {
    for (const { operator, values } of data) {
      if (CONFIG.operators.includes(operator)) {
        const currentSMA = calculateSMA(values);
        const currentValue = values[values.length - 1];
        const isDown = currentSMA.ratio > CONFIG.smaRatioThreshold || currentValue > CONFIG.absoluteThreshold;
        console.log("operator: ", operator);
        console.log("latest value: ", currentValue);
        console.log("value threshold: ", CONFIG.absoluteThreshold);
        console.log("isDown: ", isDown);
        if (isDown) {
          await sendNotification(operator, currentSMA, currentValue);
        }
        await updateOperatorStatus(operator, isDown, currentSMA.current, currentSMA.previous, currentSMA.ratio, currentValue);
      }
    }
  }
  function calculateSMA(values) {
    const recentValues = values.slice(-CONFIG.smaWindow);
    const previousValues = values.slice(-2 * CONFIG.smaWindow, -CONFIG.smaWindow);
    const recentAvg = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const previousAvg = previousValues.reduce((a, b) => a + b, 0) / previousValues.length;
    return { current: recentAvg, previous: previousAvg, ratio: recentAvg / previousAvg };
    console.log(`Current SMA: ${recentAvg}, Previous SMA: ${previousAvg}, Ratio: ${recentAvg / previousAvg}`);
  }
  async function sendNotification(operator, sma, latest) {
    const message = `Alert: ${operator} may be down. Latest value: ${latest}, SMA Ratio: ${sma.ratio.toFixed(2)}, Current SMA: ${sma.current.toFixed(2)}`;
    await fetch(CONFIG.ntfyURL, {
      method: "POST",
      body: message,
      headers: { "Content-Type": "text/plain" }
    });
  }
  async function updateOperatorStatus(operator, isDown, currentSMA, previousSMA, smaRatio, currentValue) {
    const status = {
      status: isDown ? "Down" : "Up",
      lastChecked: (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      currentSMA: Math.ceil(currentSMA),
      previousSMA: Math.ceil(previousSMA),
      smaRatio: Math.ceil(smaRatio),
      currentValue: Math.ceil(currentValue)
    };
    await MY_KV_NAMESPACE.put(operator, JSON.stringify(status));
  }
  async function getStatusData() {
    const services = [];
    for (const operator of CONFIG.operators) {
      const statusJson = await MY_KV_NAMESPACE.get(operator);
      if (statusJson) {
        const status = JSON.parse(statusJson);
        services.push({
          name: operator,
          status: status.status,
          lastChecked: status.lastChecked,
          currentSMA: status.currentSMA,
          previousSMA: status.previousSMA,
          smaRatio: status.smaRatio,
          currentValue: status.currentValue
        });
      } else {
        services.push({
          name: operator,
          status: "Unknown",
          lastChecked: "N/A",
          currentSMA: "N/A",
          previousSMA: "N/A",
          smaRatio: "N/A",
          currentValue: "N/A"
        });
      }
    }
    return services;
  }
  async function renderDashboard() {
    const services = await getStatusData();
    const rowsHtml = services.map(
      (service) => `
        <div class="service-card ${service.status === 'Up' ? 'operational' : 'disrupted'}">
          <div class="service-name">${service.name}</div>
          <div class="service-status">
            <span class="status-indicator"></span>
            ${service.status === "Up" ? 'Operational' : 'Service Disruption'}
          </div>
          <div class="service-details">
            <div class="detail-row">
              <span class="label">Latest Checked</span>
              <span class="value">${service.lastChecked}</span>
            </div>

            <div class="detail-row">
              <span class="label">Latest Reports</span>
              <span class="value">${service.currentValue || "N/A"}</span>
            </div>

            <div class="detail-row">
              <span class="label">Latest SMA</span>
              <span class="value">${service.currentSMA || "N/A"}</span>
            </div>
            <div class="detail-row">
              <span class="label">Previous SMA</span>
              <span class="value">${service.previousSMA || "N/A"}</span>
            </div>

            <div class="detail-row">
              <span class="label">Latest / Previous SMA Ratio</span>
              <span class="value">${service.smaRatio || "N/A"}</span>
            </div>            
          </div>
        </div>
      `
    ).join("");

    const upServicesCount = services.filter((service) => service.status === "Up").length;
    const heroMessage = `${upServicesCount} / ${services.length} Services Operational`;
    const subHeroMessage = `SMA window=${CONFIG.smaWindow}, source=${CONFIG.detectorURL}`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Singapore Mobile Telecom Service Status</title>
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

          .service-name {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 12px;
          }

          .service-status {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 20px;
            font-size: 14px;
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

          .service-details {
            border-top: 1px solid var(--border-color);
            padding-top: 16px;
          }

          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            font-size: 14px;
          }

          .label {
            color: var(--secondary-text);
          }

          .value {
            font-weight: 500;
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
          <h1>Singapore Mobile Telecom Service Status</h1>
          <div class="hero-message">${heroMessage}</div>
          <div class="sub-hero-message">${subHeroMessage}</div>
          <div class="services-grid">
            ${rowsHtml}
          </div>
          <footer class="footer">
            <p>Data source: <a href="https://downdetector.sg" target="_blank">Downdetector Singapore</a></p>
            <p><a href="https://github.com/jstdlee/myworkers.cloudflare/issues" target="_blank">Report an issue</a> | &copy; ${new Date().getFullYear()} All rights reserved.</p>
          </footer>
        </div>
      </body>
      </html>
    `;
    return new Response(html, { 
      headers: { 
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      } 
    });
  }
})();
//# sourceMappingURL=index.js.map
