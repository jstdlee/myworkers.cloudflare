# Service Status Monitoring System

A comprehensive service monitoring system built with Cloudflare Workers, providing real-time status tracking and a beautiful dashboard interface.

## 🌟 Features

- **Real-time Service Monitoring**: Tracks multiple service endpoints with configurable intervals
- **Basic Authentication**: Secure access to protected services
- **Beautiful Dashboard**: Apple-inspired design with dark/light mode support
- **Notification System**: Instant alerts via ntfy.sh when services go down
- **Responsive Design**: Works seamlessly on desktop and mobile devices

## 🔧 Workers

### 1. uptime.worker.js
- Main service monitoring worker
- Handles status checks and dashboard display
- Configurable service endpoints and refresh intervals
- Dark/light mode support with system preference detection


## ⚙️ Configuration

```javascript
const CONFIG = {
  urls: [
    { url: "https://example.com/" },
    { url: "https://status.example.com/" },
    {
      url: "https://private.example.com/",
      auth: { username: "username", password: "change-me" }
    }
  ],
  ntfyURL: "https://ntfy.sh/CHANGE-ME-random-topic",
  refreshInterval: 300 // 5 minutes
}
```

### 2. chatofs.worker.js
- Handles chat service with basic authentication
- Serves an interactive learning tutor interface
- Secure access control with username/password protection (set `CHAT_USERNAME`, `CHAT_PASSWORD` and `DIFY_CHATBOT_URL` as Worker secrets)
- Responsive design for all devices

### 3. downdetector.worker.js
- A simple uptime monitoring service
- Detects when a mobile telcom service is down and display a status page

### 4. sos.worker.js
- A single-page app for sending messages
- Supports ntfy.sh as a message transport
- Handles rate limiting to prevent abuse


## 🔐 Privacy note

ntfy.sh topics are public: anyone who knows the topic name can read and post to it. Use a long random topic name, and never commit the real one.

## 🎨 Design Features

- System font stack for optimal rendering
- CSS variables for theme consistency
- Responsive grid layouts
- Smooth transitions and animations
- Color-coded status indicators
- Mobile-first approach

## 📱 Mobile Support

- Responsive design adapts to all screen sizes
- Touch-friendly interface
- Optimized layout for mobile devices
- Reduced motion for better performance

## 🌐 Deployment

Deploy using Cloudflare Workers:

1. Set up a Cloudflare account
2. Create new workers for each .js file
3. Deploy the workers to Cloudflare's network
4. Configure your domain settings in Cloudflare

## 📧 Contact

For support or questions:
- Open an issue: https://github.com/jstdlee/myworkers.cloudflare/issues

## 🔄 Monitoring Strategy

- Service checks every 5 minutes
- Status code validation (200, 401)
- Immediate notifications for disruptions
- Timezone handling (Asia/Singapore)

## 🎯 Future Improvements

- Enhanced error handling
- More detailed status reporting
- User authentication system
- Additional notification channels
- Service dependency mapping

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

Made with ❤️ using Cloudflare Workers
