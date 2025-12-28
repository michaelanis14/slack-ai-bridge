require('dotenv').config();
const { App } = require("@slack/bolt");
const { spawn } = require("child_process");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Enhanced session tracking - single source of truth
const threadSessions = new Map(); // threadId -> { sessionId, process, startTime, lastActivity, type }

// Track threads that have already shown session info (only show once per thread)
const threadsWithSessionInfo = new Set(); // threadId

// Proper process cleanup helper
async function cleanupProcess(process, threadId) {
  if (!process || process.killed) return;

  return new Promise((resolve) => {
    const pid = process.pid;
    console.log(`[CLEANUP] Sending SIGTERM to process ${pid} for thread ${threadId.slice(-8)}`);

    // Try graceful shutdown first
    process.kill('SIGTERM');

    // Give it 5 seconds to exit gracefully
    const forceKillTimer = setTimeout(() => {
      if (!process.killed) {
        console.log(`[CLEANUP] Process ${pid} didn't exit, sending SIGKILL`);
        try {
          process.kill('SIGKILL');
        } catch (e) {
          console.error(`[CLEANUP] SIGKILL failed:`, e.message);
        }
      }
      resolve();
    }, 5000);

    // If it exits before timeout, cancel force kill
    process.on('exit', () => {
      clearTimeout(forceKillTimer);
      console.log(`[CLEANUP] Process ${pid} exited cleanly`);
      resolve();
    });
  });
}

// Clean up thread session completely
async function cleanupThreadSession(threadId, reason = 'unknown') {
  console.log(`[CLEANUP] Cleaning up thread ${threadId.slice(-8)}, reason: ${reason}`);

  if (!threadSessions.has(threadId)) {
    console.log(`[CLEANUP] No session found for thread ${threadId.slice(-8)}`);
    return false;
  }

  const session = threadSessions.get(threadId);

  // Kill process if running
  if (session.process && !session.process.killed) {
    await cleanupProcess(session.process, threadId);
  }

  // Remove from all tracking
  threadSessions.delete(threadId);
  threadsWithSessionInfo.delete(threadId);

  console.log(`[CLEANUP] Cleanup complete for thread ${threadId.slice(-8)}, session ${session.sessionId?.slice(0, 8) || 'unknown'}`);
  return true;
}

// Rate limiter for Slack API calls
class SlackRateLimiter {
  constructor(messagesPerSecond = 1) {
    this.queue = [];
    this.processing = false;
    this.minInterval = 1000 / messagesPerSecond; // 1 message per second by default
    this.lastSendTime = 0;
  }

  async sendMessage(messageFunc) {
    return new Promise((resolve, reject) => {
      this.queue.push({ messageFunc, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLastSend = now - this.lastSendTime;

      // Wait if we need to respect rate limit
      if (timeSinceLastSend < this.minInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastSend));
      }

      const { messageFunc, resolve, reject } = this.queue.shift();

      try {
        const result = await messageFunc();
        this.lastSendTime = Date.now();
        resolve(result);
      } catch (error) {
        console.error('[RATE-LIMITER] Message send failed:', error.message);
        reject(error);
      }
    }

    this.processing = false;
  }
}

// Global rate limiter - 1 message per second to respect Slack's limits
const slackRateLimiter = new SlackRateLimiter(1);

// Parse auto-respond channels from environment
const autoRespondChannels = new Set(
  (process.env.SLACK_AUTO_CHANNELS || '').split(',').map(c => c.trim()).filter(c => c)
);

if (autoRespondChannels.size > 0) {
  console.log(`[CONFIG] Auto-respond enabled for ${autoRespondChannels.size} channel(s)`);
} else {
  console.log(`[CONFIG] Auto-respond disabled - only responding to @mentions`);
}

async function askClaudeAsync(prompt, originalMsg, channel, threadTs, client) {
  console.log(`[ASYNC-TASK] Starting for thread ${threadTs}`);

  const startTime = Date.now();

  // Check if thread has existing session
  const existingSession = threadSessions.get(threadTs);
  const hasExistingSession = existingSession && existingSession.sessionId;

  // Add Docker environment context for backend tests
  const enhancedPrompt = `SYSTEM CONTEXT: Docker-based development environment.
Backend (Java/Kotlin/Gradle) runs ONLY in Docker containers.
For backend tests: Use "docker-compose exec backend ./gradlew test"
NEVER say "Java is not installed" - use Docker!

USER REQUEST: ${prompt}`;

  // Build command args - use --resume if session exists
  const claudeArgs = [
    '-p', enhancedPrompt,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose'
  ];

  if (hasExistingSession) {
    claudeArgs.push('--resume', existingSession.sessionId);
    console.log(`[SESSION] Resuming session ${existingSession.sessionId.slice(0, 8)}... for thread ${threadTs.slice(-8)}`);
  } else {
    console.log(`[SESSION] Starting new session for thread ${threadTs.slice(-8)}`);
  }

  const claude = spawn('/usr/bin/claude', claudeArgs, {
    cwd: '/opt/devenv/projects/sphinx-ai',
    env: {
      ...process.env,
      // Inherit full environment including Docker, Java, etc.
      HOME: '/home/developer',
      USER: 'developer'
      // PATH is inherited from process.env via spread operator
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Track in thread sessions
  threadSessions.set(threadTs, {
    sessionId: existingSession?.sessionId || null,
    process: claude,
    startTime,
    lastActivity: Date.now(),
    type: 'async'
  });

  let output = '';
  let outputBuffer = ''; // Buffer for chunked streaming
  let lastStreamTime = Date.now();
  let chunkCount = 0;
  const STREAM_INTERVAL = 15000; // Stream every 15 seconds
  const STREAM_CHUNK_SIZE = 2000; // Or when buffer reaches 2000 chars

  // Track session info
  let sessionId = null;
  let lineBuffer = ''; // Buffer for incomplete JSON lines
  let lastHeartbeat = Date.now();
  const HEARTBEAT_INTERVAL = 60000; // Send heartbeat every 60 seconds if no output

  const streamBuffer = async (force = false) => {
    const now = Date.now();
    const timeSinceLastStream = now - lastStreamTime;
    const timeSinceLastHeartbeat = now - lastHeartbeat;

    // Stream if: forced, enough time passed, or buffer is large
    if (force || timeSinceLastStream >= STREAM_INTERVAL || outputBuffer.length >= STREAM_CHUNK_SIZE) {
      if (outputBuffer.trim().length > 0) {
        const elapsed = ((now - startTime) / 1000).toFixed(0);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

        chunkCount++;

        try {
          // Post the buffered output
          const streamText = `📤 *Output Stream #${chunkCount}* (${timeStr} elapsed)\n\`\`\`\n${outputBuffer.trim()}\n\`\`\``;

          await slackRateLimiter.sendMessage(() =>
            app.client.chat.postMessage({
              channel: channel,
              text: streamText.slice(0, 3000), // Slack message limit
              thread_ts: threadTs,
              token: process.env.SLACK_BOT_TOKEN
            })
          );

          console.log(`[STREAM] Thread ${threadTs.slice(-8)}: Chunk #${chunkCount}, ${outputBuffer.length} chars, ${timeStr} elapsed`);

          // Clear buffer after streaming
          outputBuffer = '';
          lastStreamTime = now;
          lastHeartbeat = now;
        } catch (error) {
          console.error(`[STREAM] Failed to send chunk:`, error.message);
        }
      } else if (timeSinceLastHeartbeat >= HEARTBEAT_INTERVAL && !force) {
        // Send heartbeat if no output for 60 seconds
        const elapsed = ((now - startTime) / 1000).toFixed(0);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

        try {
          await slackRateLimiter.sendMessage(() =>
            app.client.chat.postMessage({
              channel: channel,
              text: `⏳ *Still working...* (${timeStr} elapsed)\n_Last output: ${chunkCount > 0 ? `Stream #${chunkCount}` : 'none yet'}_`,
              thread_ts: threadTs,
              token: process.env.SLACK_BOT_TOKEN
            })
          );

          console.log(`[HEARTBEAT] Thread ${threadTs.slice(-8)}: ${timeStr} elapsed, last chunk #${chunkCount}`);
          lastHeartbeat = now;
        } catch (error) {
          console.error(`[HEARTBEAT] Failed to send:`, error.message);
        }
      }
    }
  };

  // Stream output regularly
  const streamInterval = setInterval(() => streamBuffer(false), STREAM_INTERVAL);

  // Parse JSON stream from stdout
  const handleStreamData = (data) => {
    // Wrap in try-catch to prevent stream from breaking on errors
    try {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');

      // Keep incomplete line in buffer
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          switch(msg.type) {
            case 'system':
              // Session initialization
              if (msg.subtype === 'init' && msg.session_id) {
                sessionId = msg.session_id;
                // Update session in thread tracking
                if (threadSessions.has(threadTs)) {
                  const session = threadSessions.get(threadTs);
                  session.sessionId = sessionId;
                  session.lastActivity = Date.now();
                  console.log(`[SESSION] Session ID ${sessionId.slice(0, 8)}... registered for thread ${threadTs.slice(-8)}`);
                }
              }
              break;

            case 'assistant':
              // Tool executions and text responses
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'tool_use') {
                  // Show tool execution
                  const inputStr = JSON.stringify(item.input, null, 2);
                  const displayInput = inputStr.length > 500 ? inputStr.slice(0, 500) + '...' : inputStr;
                  // Use rate limiter - fire and forget
                  slackRateLimiter.sendMessage(() =>
                    app.client.chat.postMessage({
                      channel: channel,
                      text: `⚙️ *Tool:* ${item.name}\n\`\`\`${displayInput}\`\`\``,
                      thread_ts: threadTs,
                      token: process.env.SLACK_BOT_TOKEN
                    })
                  ).catch(e => console.error('[TOOL] Failed to send:', e.message));
                } else if (item.type === 'text' && item.text) {
                  // Add text responses to output buffer
                  outputBuffer += item.text + '\n';
                }
              }
              break;

            case 'user':
              // Tool results - add to buffer for streaming
              const toolResult = msg.message?.content?.[0];
              if (toolResult?.type === 'tool_result' && toolResult.content) {
                outputBuffer += toolResult.content + '\n';
                // Stream if buffer is getting large (non-blocking)
                if (outputBuffer.length >= STREAM_CHUNK_SIZE) {
                  streamBuffer(false).catch(e => console.error('[STREAM] Buffer error:', e.message));
                }
              }
              break;

            case 'result':
              // Final result - already handled by close event
              break;
          }
        } catch (e) {
          // Not JSON - treat as plain text output
          output += line + '\n';
          outputBuffer += line + '\n';

          // Stream if buffer is getting large (non-blocking)
          if (outputBuffer.length >= STREAM_CHUNK_SIZE) {
            streamBuffer(false).catch(e => console.error('[STREAM] Buffer error:', e.message));
          }
        }
      }
    } catch (error) {
      console.error('[STREAM] handleStreamData error:', error.message);
    }
  };

  claude.stdout.on('data', handleStreamData);
  claude.stderr.on('data', handleStreamData);

  claude.on('close', async (code) => {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ASYNC-TASK] Complete after ${duration}s, code: ${code}`);

    // Stop streaming interval
    clearInterval(streamInterval);

    // Stream any remaining buffered output
    await streamBuffer(true);

    const response = output.trim() || 'Task completed (no output)';

    // Send final summary
    try {
      const minutes = Math.floor(duration / 60);
      const seconds = (duration % 60).toFixed(1);
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      // Include session info inline if this is first reply in thread
      let summaryText = `✅ *Task Complete*\n\n⏱️ Duration: ${timeStr}\n📊 Output Chunks: ${chunkCount}\n📝 Total Output: ${output.length} characters\n✅ Exit Code: ${code}`;

      if (sessionId && !threadsWithSessionInfo.has(threadTs)) {
        summaryText += `\n\n🆔 *Session:* \`${sessionId}\`\n_Resume: \`claude --resume ${sessionId}\`_`;
        threadsWithSessionInfo.add(threadTs);
      }

      await slackRateLimiter.sendMessage(() =>
        app.client.chat.postMessage({
          channel: channel,
          text: summaryText,
          thread_ts: threadTs,
          token: process.env.SLACK_BOT_TOKEN
        })
      );

      // Add completion reaction to original message
      await client.reactions.add({
        channel: channel,
        timestamp: threadTs,
        name: "white_check_mark"
      }).catch(() => {});

      console.log(`[ASYNC-TASK] Response sent to thread ${threadTs} - ${chunkCount} chunks streamed`);

    } catch (error) {
      console.error(`[ASYNC-TASK] Failed to send response:`, error);
    }
  });

  claude.on('error', async (err) => {
    console.error(`[ASYNC-TASK] Error:`, err);

    // Stop streaming
    clearInterval(streamInterval);

    // Stream any remaining buffered output
    await streamBuffer(true);

    runningTasks.delete(threadTs);

    await slackRateLimiter.sendMessage(() =>
      app.client.chat.postMessage({
        channel: channel,
        text: `❌ *Task Failed*\n\nError: ${err.message}\n📊 Output Chunks Sent: ${chunkCount}`,
        thread_ts: threadTs,
        token: process.env.SLACK_BOT_TOKEN
      })
    ).catch(console.error);
  });
}

// Helper function to process messages (shared by app_mention and message events)
async function processMessage(event, say, client, isMention) {
  // Extract text - different structure for message vs app_mention events
  const rawText = event.text || '';

  if (!rawText) {
    console.log('[PROCESS] No text in message, skipping');
    return;
  }

  const msg = isMention
    ? rawText.replace(/<@[^>]+>/g, '').replace(/[*_~`]/g, '').trim()
    : rawText.replace(/[*_~`]/g, '').trim();
  const threadTs = event.thread_ts || event.ts;
  const channel = event.channel;
  const isNewThread = !event.thread_ts;

  if (!msg) {
    await say({
      text: "Hi! I can handle long-running tasks and remember our conversation!",
      thread_ts: threadTs
    });
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${isNewThread ? 'NEW THREAD' : 'THREAD REPLY'}] ${msg}`);
  console.log(`Thread ID: ${threadTs}`);
  console.log(`${'='.repeat(60)}`);

  // Handle "close" command - cleanup session
  if (msg.toLowerCase() === 'close') {
    const cleaned = await cleanupThreadSession(threadTs, 'close command');

    // Send confirmation
    if (cleaned) {
      await say({
        text: `🛑 *Session Closed*\n\nStopped running task and cleaned up session for this thread.`,
        thread_ts: threadTs
      });
    } else {
      await say({
        text: `ℹ️ No active session found for this thread.`,
        thread_ts: threadTs
      });
    }

    return; // Don't process as normal message
  }

  // Detect if this is likely a long-running task
  const isLongTask = /run.*test|build|deploy|analyze.*all|scan|compile|install/i.test(msg);

  if (isLongTask) {
    console.log('[LONG-TASK] Detected, running async');

    // Immediate acknowledgment
    await say({
      text: `🔄 Working on this... I'll reply in this thread when complete.\n\n_Task: ${msg}_`,
      thread_ts: threadTs
    });

    await client.reactions.add({
      channel: channel,
      timestamp: event.ts,
      name: "rocket"
    }).catch(() => {});

    // Start async task (Claude Code handles context via --resume)
    askClaudeAsync(msg, msg, channel, threadTs, client);

  } else {
    // Regular short task - wait for response
    console.log('[SHORT-TASK] Running sync');

    await client.reactions.add({
      channel: channel,
      timestamp: event.ts,
      name: "brain"  // Brain emoji to indicate context awareness
    }).catch(() => {});

    // Check if thread has existing session
    const existingSession = threadSessions.get(threadTs);
    const hasExistingSession = existingSession && existingSession.sessionId;

    // Quick synchronous execution
    // Add Docker environment context
    const enhancedPrompt = `SYSTEM CONTEXT: Docker-based development environment.
Backend (Java/Kotlin/Gradle) runs ONLY in Docker containers.
For backend tests: Use "docker-compose exec backend ./gradlew test"
NEVER say "Java is not installed" - use Docker!

USER REQUEST: ${msg}`;

    // Build command args - use --resume if session exists
    const claudeArgs = [
      '-p', enhancedPrompt,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose'
    ];

    if (hasExistingSession) {
      claudeArgs.push('--resume', existingSession.sessionId);
      console.log(`[SESSION] Resuming session ${existingSession.sessionId.slice(0, 8)}... for thread ${threadTs.slice(-8)}`);
    } else {
      console.log(`[SESSION] Starting new session for thread ${threadTs.slice(-8)}`);
    }

    const response = await new Promise((resolve) => {
      const claude = spawn('/usr/bin/claude', claudeArgs, {
        cwd: '/opt/devenv/projects/sphinx-ai',
        env: {
          ...process.env,
          // Inherit full environment including Docker, Java, etc.
          HOME: '/home/developer',
          USER: 'developer'
          // PATH is inherited from process.env via spread operator
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Track in thread sessions
      threadSessions.set(threadTs, {
        sessionId: existingSession?.sessionId || null,
        process: claude,
        startTime: Date.now(),
        lastActivity: Date.now(),
        type: 'sync'
      });

      let output = '';
      let result = '';
      let syncSessionId = null;

      claude.stdout.on('data', d => {
        output += d.toString();
        // Try to extract result and session ID from JSON stream
        const lines = output.split('\n');
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'result' && msg.result) {
              result = msg.result;
            }
            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
              syncSessionId = msg.session_id;
              // Update session in tracking
              if (threadSessions.has(threadTs)) {
                threadSessions.get(threadTs).sessionId = syncSessionId;
                threadSessions.get(threadTs).lastActivity = Date.now();
                console.log(`[SESSION] Session ID ${syncSessionId.slice(0, 8)}... registered for thread ${threadTs.slice(-8)}`);
              }
            }
          } catch (e) {
            // Not JSON, ignore
          }
        }
      });

      claude.stderr.on('data', d => output += d);
      claude.on('close', () => resolve({ response: result || output.trim() || 'No output', sessionId: syncSessionId }));

      setTimeout(() => {
        claude.kill();
        resolve({ response: result || output.trim() || 'Timeout', sessionId: syncSessionId });
      }, 90000);
    });

    // Send response with inline session info (only for first reply in thread)
    let responseText = response.response || response;

    if (response.sessionId && !threadsWithSessionInfo.has(threadTs)) {
      responseText += `\n\n🆔 *Session:* \`${response.sessionId}\` | _Resume: \`claude --resume ${response.sessionId}\`_`;
      threadsWithSessionInfo.add(threadTs);
    }

    await say({ text: responseText.slice(0, 3000), thread_ts: threadTs });

    await client.reactions.remove({
      channel: channel,
      timestamp: event.ts,
      name: "brain"
    }).catch(() => {});

    await client.reactions.add({
      channel: channel,
      timestamp: event.ts,
      name: "white_check_mark"
    }).catch(() => {});
  }
}

// Handle regular channel messages (auto-respond channels)
app.event("message", async ({ event, say, client }) => {
  try {
    // Ignore bot messages
    if (event.bot_id || event.subtype === 'bot_message') return;

    // Only respond in configured auto-respond channels
    if (!autoRespondChannels.has(event.channel)) return;

    const messageType = event.thread_ts ? 'thread reply' : 'channel message';
    console.log(`[AUTO-CHANNEL] ${messageType} in ${event.channel}`);
    await processMessage(event, say, client, false);
  } catch (error) {
    console.error('[AUTO-CHANNEL ERROR]', error);
  }
});

// Handle @mentions
app.event("app_mention", async ({ event, say, client }) => {
  try {
    await processMessage(event, say, client, true);
  } catch (error) {
    console.error('[MENTION ERROR]', error);
    await say({
      text: 'Error: ' + error.message,
      thread_ts: event.thread_ts || event.ts
    }).catch(console.error);
  }
});

// Handle message deletions - cleanup associated sessions
app.event("message_metadata_deleted", async ({ event }) => {
  try {
    console.log(`[CLEANUP] Message metadata deleted event received:`, JSON.stringify(event));
    const deletedTs = event.deleted_ts || event.message_ts || event.ts;

    // Use unified cleanup function
    await cleanupThreadSession(deletedTs, 'message deleted');
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
  }
});

// Monitor sessions and cleanup orphans
setInterval(async () => {
  if (threadSessions.size > 0) {
    console.log(`[STATUS] ${threadSessions.size} active sessions`);

    const now = Date.now();
    const ORPHAN_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

    for (const [threadId, session] of threadSessions.entries()) {
      const elapsed = ((now - session.startTime) / 1000).toFixed(0);
      const idle = ((now - session.lastActivity) / 1000 / 60).toFixed(1);

      console.log(`  - Thread ${threadId.slice(-6)}: ${session.type}, ${elapsed}s elapsed, idle ${idle}m, session ${session.sessionId?.slice(0, 8) || 'pending'}...`);

      // Detect and cleanup orphan processes (inactive for > 2 hours)
      if (now - session.lastActivity > ORPHAN_TIMEOUT) {
        console.log(`[ORPHAN] Detected orphan session for thread ${threadId.slice(-8)}, idle ${idle}m - cleaning up`);
        await cleanupThreadSession(threadId, 'orphan timeout');
      }
    }
  }
}, 2 * 60 * 1000); // Status every 2 minutes

app.start().then(() => {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║  🧠 Slack-Claude Bridge v3.0.0                    ║');
  console.log('║                                                   ║');
  console.log('║  ✅ Native Claude session resuming (--resume)     ║');
  console.log('║  ✅ Auto-respond in configured channels           ║');
  console.log('║  ✅ Type "close" to stop & cleanup                ║');
  console.log('║  ✅ Robust process cleanup (SIGTERM/SIGKILL)      ║');
  console.log('║  ✅ Orphan detection & auto-cleanup               ║');
  console.log('║  ✅ Structured JSON streaming                     ║');
  console.log('║  ✅ Rate-limited Slack API (1 msg/sec)            ║');
  console.log('║  ✅ Session inline with first reply               ║');
  console.log('║  ✅ Real-time tool execution updates              ║');
  console.log('║  ✅ Docker-aware for backend tests                ║');
  console.log('╚═══════════════════════════════════════════════════╗');
  console.log('Ready! Claude manages context natively via --resume.');
});
