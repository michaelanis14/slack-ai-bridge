require('dotenv').config();
const { App } = require("@slack/bolt");
const { spawn } = require("child_process");
const { buildPromptWithContext, addToThreadContext, getAllThreadContexts } = require("./context");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Track running tasks
const runningTasks = new Map(); // threadId -> { process, startTime }

async function askClaudeAsync(prompt, originalMsg, channel, threadTs, client) {
  console.log(`[ASYNC-TASK] Starting for thread ${threadTs}`);

  const startTime = Date.now();

  // Add Docker environment context for backend tests
  const enhancedPrompt = `SYSTEM CONTEXT: Docker-based development environment.
Backend (Java/Kotlin/Gradle) runs ONLY in Docker containers.
For backend tests: Use "docker-compose exec backend ./gradlew test"
NEVER say "Java is not installed" - use Docker!

USER REQUEST: ${prompt}`;

  const claude = spawn('/usr/bin/claude', ['--print', '--dangerously-skip-permissions', enhancedPrompt], {
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

  runningTasks.set(threadTs, { process: claude, startTime });

  let output = '';
  let outputBuffer = ''; // Buffer for chunked streaming
  let lastStreamTime = Date.now();
  let chunkCount = 0;
  const STREAM_INTERVAL = 15000; // Stream every 15 seconds
  const STREAM_CHUNK_SIZE = 2000; // Or when buffer reaches 2000 chars

  // Function to stream buffered output
  const streamBuffer = async (force = false) => {
    const now = Date.now();
    const timeSinceLastStream = now - lastStreamTime;

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

          await app.client.chat.postMessage({
            channel: channel,
            text: streamText.slice(0, 3000), // Slack message limit
            thread_ts: threadTs,
            token: process.env.SLACK_BOT_TOKEN
          });

          console.log(`[STREAM] Thread ${threadTs.slice(-8)}: Chunk #${chunkCount}, ${outputBuffer.length} chars, ${timeStr} elapsed`);

          // Clear buffer after streaming
          outputBuffer = '';
          lastStreamTime = now;
        } catch (error) {
          console.error(`[STREAM] Failed to send chunk:`, error.message);
        }
      }
    }
  };

  // Stream output regularly
  const streamInterval = setInterval(() => streamBuffer(false), STREAM_INTERVAL);

  claude.stdout.on('data', (data) => {
    const chunk = data.toString();
    output += chunk;
    outputBuffer += chunk;

    // Stream if buffer is getting large
    if (outputBuffer.length >= STREAM_CHUNK_SIZE) {
      streamBuffer(false);
    }
  });

  claude.stderr.on('data', (data) => {
    const chunk = data.toString();
    output += chunk;
    outputBuffer += chunk;

    // Stream if buffer is getting large
    if (outputBuffer.length >= STREAM_CHUNK_SIZE) {
      streamBuffer(false);
    }
  });

  claude.on('close', async (code) => {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ASYNC-TASK] Complete after ${duration}s, code: ${code}`);

    // Stop streaming interval
    clearInterval(streamInterval);

    // Stream any remaining buffered output
    await streamBuffer(true);

    runningTasks.delete(threadTs);

    const response = output.trim() || 'Task completed (no output)';

    // STORE IN CONTEXT
    addToThreadContext(threadTs, originalMsg, response);

    // Send final summary
    try {
      const minutes = Math.floor(duration / 60);
      const seconds = (duration % 60).toFixed(1);
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      await app.client.chat.postMessage({
        channel: channel,
        text: `✅ *Task Complete*\n\n⏱️ Duration: ${timeStr}\n📊 Output Chunks: ${chunkCount}\n📝 Total Output: ${output.length} characters\n✅ Exit Code: ${code}`,
        thread_ts: threadTs,
        token: process.env.SLACK_BOT_TOKEN
      });

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

    await app.client.chat.postMessage({
      channel: channel,
      text: `❌ *Task Failed*\n\nError: ${err.message}\n📊 Output Chunks Sent: ${chunkCount}`,
      thread_ts: threadTs,
      token: process.env.SLACK_BOT_TOKEN
    }).catch(console.error);
  });
}

app.event("app_mention", async ({ event, say, client }) => {
  try {
    const msg = event.text.replace(/<@[^>]+>/g, '').replace(/[*_~`]/g, '').trim();
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

    // BUILD PROMPT WITH CONTEXT - This is the key change!
    const promptWithContext = buildPromptWithContext(threadTs, msg);

    // Log if using context
    if (promptWithContext !== msg) {
      console.log(`[CONTEXT] Using history for context`);
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

      // Start async task (doesn't wait) - pass original msg for context storage
      askClaudeAsync(promptWithContext, msg, channel, threadTs, client);

    } else {
      // Regular short task - wait for response
      console.log('[SHORT-TASK] Running sync');

      await client.reactions.add({
        channel: channel,
        timestamp: event.ts,
        name: "brain"  // Brain emoji to indicate context awareness
      }).catch(() => {});

      // Quick synchronous execution with context
      // Add Docker environment context
      const enhancedPrompt = `SYSTEM CONTEXT: Docker-based development environment.
Backend (Java/Kotlin/Gradle) runs ONLY in Docker containers.
For backend tests: Use "docker-compose exec backend ./gradlew test"
NEVER say "Java is not installed" - use Docker!

USER REQUEST: ${promptWithContext}`;

      const response = await new Promise((resolve) => {
        const claude = spawn('/usr/bin/claude', ['--print', '--dangerously-skip-permissions', enhancedPrompt], {
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

        let output = '';
        claude.stdout.on('data', d => output += d);
        claude.stderr.on('data', d => output += d);
        claude.on('close', () => resolve(output.trim() || 'No output'));

        setTimeout(() => {
          claude.kill();
          resolve(output.trim() || 'Timeout');
        }, 90000);
      });

      // STORE IN CONTEXT
      addToThreadContext(threadTs, msg, response);

      await say({ text: response.slice(0, 3000), thread_ts: threadTs });

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

  } catch (error) {
    console.error('[ERROR]', error);
    await say({
      text: 'Error: ' + error.message,
      thread_ts: event.thread_ts || event.ts
    }).catch(console.error);
  }
});

// Show running tasks and context status
setInterval(() => {
  if (runningTasks.size > 0) {
    console.log(`[STATUS] ${runningTasks.size} tasks running`);
    for (const [threadId, task] of runningTasks.entries()) {
      const elapsed = ((Date.now() - task.startTime) / 1000).toFixed(0);
      console.log(`  - Thread ${threadId.slice(-6)}: ${elapsed}s elapsed`);
    }
  }

  // Monitor context storage
  const threadContexts = getAllThreadContexts();
  if (threadContexts.size > 0) {
    console.log(`\n[CONTEXT STATUS] ${threadContexts.size} threads with conversation memory:`);
    for (const [threadId, ctx] of threadContexts.entries()) {
      const idleTime = ((Date.now() - ctx.lastActivity) / 1000 / 60).toFixed(1);
      console.log(`  Thread ...${threadId.slice(-8)}: ${ctx.history.length} exchanges, idle ${idleTime}m`);
    }
  }
}, 2 * 60 * 1000); // Status every 2 minutes

app.start().then(() => {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║  🧠 Context Memory Bridge v2.2                    ║');
  console.log('║                                                   ║');
  console.log('║  ✅ Remembers conversations within threads        ║');
  console.log('║  ✅ Full output streaming (15s chunks)            ║');
  console.log('║  ✅ Real-time progress - see ALL output           ║');
  console.log('║  ✅ Stores last 10 exchanges per thread           ║');
  console.log('║  ✅ Auto-cleanup after 30min idle                 ║');
  console.log('║  ✅ Docker-aware for backend tests                ║');
  console.log('╚═══════════════════════════════════════════════════╗');
  console.log('Ready with full output streaming!');
});
