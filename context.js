/**
 * Conversation context memory for Slack-Claude Bridge
 * Stores thread-specific conversation history to maintain context
 */

// Conversation history storage
const threadContexts = new Map(); // threadId -> {history: [], lastActivity: number, timeout: NodeJS.Timeout}
const MAX_HISTORY_ITEMS = 10;
const CONTEXT_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create context for a thread
 * @param {string} threadId - Slack thread ID
 * @returns {Object} Thread context with history, lastActivity, and timeout
 */
function getThreadContext(threadId) {
  if (!threadContexts.has(threadId)) {
    threadContexts.set(threadId, {
      history: [],
      lastActivity: Date.now(),
      timeout: setTimeout(() => {
        threadContexts.delete(threadId);
        console.log(`[CONTEXT] Cleared thread ${threadId.slice(-8)}`);
      }, CONTEXT_TTL)
    });
  }

  const context = threadContexts.get(threadId);
  context.lastActivity = Date.now();

  // Reset timeout
  clearTimeout(context.timeout);
  context.timeout = setTimeout(() => {
    threadContexts.delete(threadId);
    console.log(`[CONTEXT] Cleared thread ${threadId.slice(-8)}`);
  }, CONTEXT_TTL);

  return context;
}

/**
 * Add a user-assistant exchange to thread context
 * @param {string} threadId - Slack thread ID
 * @param {string} userMsg - User's message
 * @param {string} assistantResp - Claude's response
 */
function addToThreadContext(threadId, userMsg, assistantResp) {
  const context = getThreadContext(threadId);

  context.history.push({
    user: userMsg,
    assistant: assistantResp
  });

  // Keep only last N exchanges
  if (context.history.length > MAX_HISTORY_ITEMS) {
    context.history.shift();
  }

  console.log(`[CONTEXT] Thread ${threadId.slice(-8)}: ${context.history.length} exchanges stored`);
}

/**
 * Build a prompt that includes conversation context
 * @param {string} threadId - Slack thread ID
 * @param {string} currentMsg - Current user message
 * @returns {string} Prompt with context or just the message if no history
 */
function buildPromptWithContext(threadId, currentMsg) {
  const context = getThreadContext(threadId);
  const history = context.history;

  if (history.length === 0) {
    // No previous context
    return currentMsg;
  }

  // Build context-aware prompt
  let contextPrompt = "Previous conversation in this thread:\n\n";

  for (let i = 0; i < history.length; i++) {
    const exchange = history[i];
    contextPrompt += `[Message ${i + 1}]\n`;
    contextPrompt += `User: ${exchange.user}\n`;

    // Truncate long responses but keep key info
    const respPreview = exchange.assistant.length > 200
      ? exchange.assistant.slice(0, 200) + '...'
      : exchange.assistant;

    contextPrompt += `Assistant: ${respPreview}\n\n`;
  }

  contextPrompt += `${'='.repeat(50)}\n\n`;
  contextPrompt += `Current question (use the context above if relevant):\n${currentMsg}`;

  console.log(`[CONTEXT] Built prompt with ${history.length} previous exchanges`);

  return contextPrompt;
}

/**
 * Clear all thread contexts (for testing)
 */
function clearThreadContext() {
  // Clear all timeouts
  for (const [threadId, context] of threadContexts.entries()) {
    clearTimeout(context.timeout);
  }
  threadContexts.clear();
}

/**
 * Get all thread contexts (for monitoring)
 * @returns {Map} All thread contexts
 */
function getAllThreadContexts() {
  return threadContexts;
}

module.exports = {
  getThreadContext,
  addToThreadContext,
  buildPromptWithContext,
  clearThreadContext,
  getAllThreadContexts
};
