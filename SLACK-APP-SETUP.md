# Slack App Configuration Guide

This guide covers the complete setup for the Slack-Claude Bridge, including all required scopes and event subscriptions.

## Prerequisites

- Access to create/manage Slack apps at https://api.slack.com/apps
- Admin permissions in your Slack workspace

## Step 1: Create Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App**
3. Choose **From scratch**
4. Name: `Claude Code Bridge` (or your preferred name)
5. Select your workspace
6. Click **Create App**

## Step 2: Enable Socket Mode

1. In your app settings, go to **Socket Mode** (left sidebar)
2. Toggle **Enable Socket Mode** to ON
3. Generate an app-level token:
   - Token Name: `socket-mode-token`
   - Scopes: `connections:write`
   - Click **Generate**
   - **Copy the token** (starts with `xapp-`) → This is your `SLACK_APP_TOKEN`

## Step 3: Configure OAuth & Permissions

1. Go to **OAuth & Permissions** (left sidebar)
2. Scroll to **Scopes** section
3. Under **Bot Token Scopes**, add the following:

### Required Bot Scopes

**Message Access:**
- `app_mentions:read` - Read @mentions of the bot
- `channels:history` - Read message history in public channels
- `channels:read` - View basic channel information
- `im:history` - Read message history in DMs
- `im:read` - View basic DM information
- `im:write` - Send messages in DMs

**Message Management:**
- `chat:write` - Send messages as the bot
- `chat:write.public` - Send messages to channels without joining
- `reactions:write` - Add emoji reactions to messages

**Message Metadata (for deletion tracking):**
- `metadata.message:read` - Read message metadata (required for message_metadata_deleted event)

**File Access (optional, for future features):**
- `files:read` - View files shared in channels
- `files:write` - Upload files

4. Click **Save Changes**

## Step 4: Install App to Workspace

1. Scroll up to **OAuth Tokens for Your Workspace**
2. Click **Install to Workspace**
3. Review permissions and click **Allow**
4. **Copy the Bot User OAuth Token** (starts with `xoxb-`) → This is your `SLACK_BOT_TOKEN`

## Step 5: Configure Event Subscriptions

1. Go to **Event Subscriptions** (left sidebar)
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, add:

### Required Bot Events

**Message Events:**
- `app_mention` - Listen for @mentions
- `message.channels` - Listen to messages in public channels (for auto-respond)
- `message.im` - Listen to direct messages
- `message_metadata_deleted` - **[NEW]** Listen for message deletions (for session cleanup)
  - Also requires scope: `metadata.message:read`

4. Click **Save Changes**
5. Slack will prompt you to **reinstall the app** - click **Reinstall App**

## Step 6: Get Your Channel ID

To enable auto-respond in specific channels:

1. Open Slack desktop/web app
2. Navigate to the channel where you want auto-respond
3. Right-click the channel name
4. Select **View channel details**
5. Scroll to the bottom
6. **Copy the Channel ID** (starts with `C`, e.g., `C0A5P38U0FM`)

## Step 7: Configure Environment Variables

1. Edit your `.env` file:
```bash
nano /opt/devenv/projects/slack-claude-bridge/.env
```

2. Add/update the following:
```bash
# Required Slack tokens
SLACK_BOT_TOKEN=xoxb-your-actual-bot-token-here
SLACK_APP_TOKEN=xapp-your-actual-app-token-here
SLACK_SIGNING_SECRET=your-signing-secret-from-app-settings

# Auto-respond channels (comma-separated channel IDs)
# Example: C0A5P38U0FM,C987654321
SLACK_AUTO_CHANNELS=C0A5P38U0FM

# Optional: Anthropic API key (for fallback, not used in current setup)
# ANTHROPIC_API_KEY=sk-ant-your-key-here
```

3. Save the file (Ctrl+O, Enter, Ctrl+X)

## Step 8: Get Signing Secret

1. In your Slack app settings, go to **Basic Information**
2. Scroll to **App Credentials**
3. **Copy the Signing Secret** → This is your `SLACK_SIGNING_SECRET`
4. Add it to your `.env` file

## Step 9: Restart the Bridge

```bash
sudo systemctl restart slack-claude-bridge
```

Check if it's running:
```bash
sudo systemctl status slack-claude-bridge
```

You should see:
```
● slack-claude-bridge.service - v2.6.0
   Status: active (running)
   [CONFIG] Auto-respond enabled for 1 channel(s)
   Now connected to Slack
```

## Step 10: Verify Setup

### Test Auto-Respond
1. Go to your configured channel (e.g., C0A5P38U0FM)
2. Send a message: `hello`
3. Bot should respond without needing @mention

### Test @Mentions
1. In any other channel or DM
2. Send: `@Claude Code what is 2+2?`
3. Bot should respond

### Test Session Cleanup
1. Send a task: `run tests`
2. Note the session ID in the response
3. Delete the message in Slack
4. Check logs: `sudo journalctl -u slack-claude-bridge -f`
5. You should see cleanup logs

## Troubleshooting

### Bot Not Responding
- Check logs: `sudo journalctl -u slack-claude-bridge -f`
- Verify tokens in `.env` are correct
- Ensure Socket Mode is enabled
- Check app is installed to workspace

### Missing Events
- Verify event subscriptions include all required events
- Reinstall app after adding new events
- Check Slack app manifest for event subscriptions

### Session Cleanup Not Working
- Verify `message_metadata_deleted` event is subscribed (NOT `message_deleted`)
- Add `metadata.message:read` scope
- Reinstall app after adding the event and scope
- Check logs for "[CLEANUP]" messages
- Test by deleting a message and checking logs: `sudo journalctl -u slack-claude-bridge -f`

### Permission Errors
- Review OAuth scopes in app settings
- Reinstall app after adding new scopes
- Ensure bot is invited to channels (for non-auto-respond channels)

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token | `xoxb-123...` |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode | `xapp-1-A...` |
| `SLACK_SIGNING_SECRET` | Yes | For request verification | `abc123...` |
| `SLACK_AUTO_CHANNELS` | No | Channels for auto-respond (no @mention) | `C0A5P38U0FM,C123...` |
| `ANTHROPIC_API_KEY` | No | For API fallback (not currently used) | `sk-ant-...` |

## Required Slack App Manifest (Reference)

If you want to recreate the app from scratch, here's the complete manifest:

```yaml
display_information:
  name: Claude Code Bridge
  description: AI assistant bridge to Claude Code CLI
  background_color: "#000000"
features:
  bot_user:
    display_name: Claude Code
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - chat:write.public
      - im:history
      - im:read
      - im:write
      - reactions:write
      - metadata.message:read
      - files:read
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.im
      - message_metadata_deleted
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## Service Management

**Start/Stop/Restart:**
```bash
sudo systemctl start slack-claude-bridge
sudo systemctl stop slack-claude-bridge
sudo systemctl restart slack-claude-bridge
```

**View Logs:**
```bash
# Real-time logs
sudo journalctl -u slack-claude-bridge -f

# Last 100 lines
sudo journalctl -u slack-claude-bridge -n 100
```

**Check Status:**
```bash
sudo systemctl status slack-claude-bridge
```

**Disable Auto-Start:**
```bash
sudo systemctl disable slack-claude-bridge
```

**Enable Auto-Start:**
```bash
sudo systemctl enable slack-claude-bridge
```

## Testing Checklist

- [ ] Bot responds to @mentions in any channel
- [ ] Bot responds without @mention in configured channels
- [ ] Thread replies work in auto-respond channels
- [ ] Session info appears at task start
- [ ] Long-running tasks show progress updates
- [ ] Heartbeat messages appear during silent periods (60s)
- [ ] Task completion summary appears
- [ ] Message deletion triggers cleanup (check logs)
- [ ] Context memory works across thread replies
- [ ] Rate limiting prevents API errors

## Support

If you encounter issues:
1. Check service logs: `sudo journalctl -u slack-claude-bridge -f`
2. Verify `.env` configuration
3. Test tokens manually with Slack API test endpoints
4. Review Slack app event subscriptions
5. Check GitHub issues: https://github.com/michaelanis14/slack-ai-bridge/issues
