# Slack AI Bridge

> Connect Slack to an AI assistant with full access to all configured MCP servers.

## Overview

The Slack AI Bridge enables seamless communication with an AI assistant through Slack, providing AI-assisted development capabilities directly in your team's chat workspace. The bridge gives the AI full access to your development environment, MCP servers, and project context.

## ✨ Features

- 🧠 **Conversation Memory** - Remembers context within threads
- 📊 **Full Output Streaming** - See ALL output in real-time, not just snippets
- ⚡ **Fast Updates** - Streams every 15s or 2000 chars
- 🐳 **Docker-Aware** - Automatically uses Docker for backend tests
- 🤖 **Natural Conversation** - @mention the bot or send DMs
- ⚡ **Fast Responses** - ~11-20 seconds per query
- 🔌 **Full MCP Access** - Slack, Jira, filesystem, memory, context7, puppeteer
- 🧵 **Threaded Responses** - Organized conversations with isolated contexts
- 👁️ **Visual Feedback** - Reaction indicators (🧠 thinking, ✅ complete)
- 🔄 **Auto-reconnect** - Resilient Socket Mode connection
- 📝 **Complete Output History** - All chunks preserved in thread
- 🛡️ **Error Handling** - Graceful failure with clear error messages
- 🎯 **Smart Task Detection** - Auto-detects long-running tasks for async execution

## Architecture

```
Slack Message → Socket Mode → Bridge (Node.js) → Spawn AI CLI → MCP Servers
                                                        ↓
                                                  Response → Slack
```

## Prerequisites

### Slack App Configuration

1. **Create Slack App** at https://api.slack.com/apps

2. **Enable Socket Mode:**
   - Socket Mode → Toggle ON
   - Generate app-level token with `connections:write` scope

3. **Configure OAuth & Permissions:**
   Add these Bot Token Scopes:
   - `app_mentions:read` - Receive @mentions
   - `chat:write` - Send messages
   - `channels:read` - View channel info
   - `channels:history` - Read channel messages
   - `im:read` - View DMs
   - `im:history` - Read DM history
   - `im:write` - Send DMs
   - `reactions:write` - Add emoji reactions

4. **Enable Event Subscriptions:**
   - Subscribe to bot events:
     - `app_mention` - When users @mention your bot
     - `message.im` - Direct messages to bot

5. **Install to Workspace**

### Server Requirements

- Node.js 18+
- AI CLI tool installed and authenticated
- MCP servers configured
- Running as developer user (not root)

## Installation

```bash
cd /opt/devenv/projects/slack-claude-bridge
npm install
```

## Configuration

Create `.env` file:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
```

## Running

```bash
node index.js
```

## Usage

### In Slack

```
@bot run backend unit tests
@bot list my Jira issues
@bot help me debug this error
@bot what's the project structure?
```

## Features

### Context Memory (v2.0)

Bot remembers previous exchanges within threads:

```
You: my name is Alice
Bot: Nice to meet you, Alice!

You: what's my name?
Bot: Your name is Alice! ✅
```

### Full Output Streaming (v2.2)

See ALL output in real-time:

```
You: @bot run backend tests
Bot: 🔄 Working on this...

[15s later - Chunk #1]
📤 Output Stream #1 (15s elapsed)
[Compilation output...]

[15s later - Chunk #2]
📤 Output Stream #2 (30s elapsed)
[Test execution...]

[Complete]
✅ Task Complete
⏱️ 1m 2.5s | 📊 4 chunks
```

### Docker-Aware (v2.1.1)

Automatically uses Docker for containerized tools - no configuration needed.

## Changelog

### v2.2.0 (2025-12-27)
- Full output streaming (all output, not just snippets)
- 15-second stream interval
- Chunked output posting

### v2.1.1 (2025-12-27)
- Docker environment awareness
- System context injection

### v2.1.0 (2025-12-27)
- Streaming progress updates

### v2.0.0 (2025-12-27)
- Conversation context memory
- Thread-isolated contexts
- 12/12 tests passing

### v1.0.0 (2025-12-27)
- Initial working implementation

## License

MIT
