# Slack AI Bridge - Setup Guide

## Quick Start

### 1. Prerequisites
- Node.js 18+
- Slack workspace with admin access
- AI CLI tool installed

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Slack App

Create a Slack app at https://api.slack.com/apps with:
- Socket Mode enabled
- Bot Token Scopes: app_mentions:read, chat:write, reactions:write
- Event Subscriptions: app_mention, message.im

### 4. Environment Setup

Create `.env`:
```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

### 5. Run

```bash
node index.js
```

See README.md for complete documentation.
