/**
 * Test suite for conversation context memory
 * TDD RED phase - These tests will fail until implementation is complete
 */

const {
  getThreadContext,
  addToThreadContext,
  buildPromptWithContext,
  clearThreadContext
} = require('./context');

describe('Context Memory Functions', () => {
  // Clear all contexts before each test
  beforeEach(() => {
    clearThreadContext();
  });

  // Clean up after all tests to prevent Jest hanging
  afterAll(() => {
    clearThreadContext();
  });

  describe('getThreadContext', () => {
    test('should create new context for new thread', () => {
      const threadId = 'test-thread-1';
      const context = getThreadContext(threadId);

      expect(context).toBeDefined();
      expect(context.history).toEqual([]);
      expect(context.lastActivity).toBeDefined();
      expect(context.timeout).toBeDefined();
    });

    test('should return same context for same thread', () => {
      const threadId = 'test-thread-1';
      const context1 = getThreadContext(threadId);
      const context2 = getThreadContext(threadId);

      expect(context1).toBe(context2);
    });

    test('should update lastActivity when accessed', (done) => {
      const threadId = 'test-thread-1';
      const context1 = getThreadContext(threadId);
      const firstActivity = context1.lastActivity;

      setTimeout(() => {
        const context2 = getThreadContext(threadId);
        expect(context2.lastActivity).toBeGreaterThan(firstActivity);
        done();
      }, 10);
    });
  });

  describe('addToThreadContext', () => {
    test('should add exchange to thread history', () => {
      const threadId = 'test-thread-1';
      const userMsg = 'Hello';
      const assistantResp = 'Hi there!';

      addToThreadContext(threadId, userMsg, assistantResp);

      const context = getThreadContext(threadId);
      expect(context.history.length).toBe(1);
      expect(context.history[0]).toEqual({
        user: userMsg,
        assistant: assistantResp
      });
    });

    test('should maintain multiple exchanges in order', () => {
      const threadId = 'test-thread-1';

      addToThreadContext(threadId, 'First message', 'First response');
      addToThreadContext(threadId, 'Second message', 'Second response');
      addToThreadContext(threadId, 'Third message', 'Third response');

      const context = getThreadContext(threadId);
      expect(context.history.length).toBe(3);
      expect(context.history[0].user).toBe('First message');
      expect(context.history[1].user).toBe('Second message');
      expect(context.history[2].user).toBe('Third message');
    });

    test('should limit history to MAX_HISTORY_ITEMS (10)', () => {
      const threadId = 'test-thread-1';

      // Add 15 exchanges
      for (let i = 1; i <= 15; i++) {
        addToThreadContext(threadId, `Message ${i}`, `Response ${i}`);
      }

      const context = getThreadContext(threadId);
      expect(context.history.length).toBe(10);
      // Should keep the most recent 10 (6-15)
      expect(context.history[0].user).toBe('Message 6');
      expect(context.history[9].user).toBe('Message 15');
    });
  });

  describe('buildPromptWithContext', () => {
    test('should return original message when no history exists', () => {
      const threadId = 'test-thread-1';
      const message = 'What is the weather?';

      const prompt = buildPromptWithContext(threadId, message);

      expect(prompt).toBe(message);
    });

    test('should include previous exchanges in prompt', () => {
      const threadId = 'test-thread-1';

      addToThreadContext(threadId, 'My name is Alice', 'Nice to meet you, Alice!');

      const prompt = buildPromptWithContext(threadId, 'What is my name?');

      expect(prompt).toContain('Previous conversation');
      expect(prompt).toContain('My name is Alice');
      expect(prompt).toContain('Nice to meet you, Alice!');
      expect(prompt).toContain('What is my name?');
    });

    test('should truncate long assistant responses', () => {
      const threadId = 'test-thread-1';
      const longResponse = 'A'.repeat(300);

      addToThreadContext(threadId, 'Tell me a story', longResponse);

      const prompt = buildPromptWithContext(threadId, 'What did you say?');

      // Should truncate to ~200 chars (the prompt includes headers and separators)
      // Long response (300) gets truncated to 200+... = 203
      // Plus context headers and current message
      expect(prompt.length).toBeLessThan(500); // Reasonable upper bound
      expect(prompt).toContain('...');
    });

    test('should format context with separators', () => {
      const threadId = 'test-thread-1';

      addToThreadContext(threadId, 'First', 'Response 1');
      addToThreadContext(threadId, 'Second', 'Response 2');

      const prompt = buildPromptWithContext(threadId, 'Current question');

      expect(prompt).toContain('[Message 1]');
      expect(prompt).toContain('[Message 2]');
      expect(prompt).toContain('='.repeat(50));
      expect(prompt).toContain('Current question');
    });
  });

  describe('Thread isolation', () => {
    test('should keep different thread contexts separate', () => {
      const thread1 = 'thread-1';
      const thread2 = 'thread-2';

      addToThreadContext(thread1, 'Color is blue', 'Noted: blue');
      addToThreadContext(thread2, 'Color is red', 'Noted: red');

      const context1 = getThreadContext(thread1);
      const context2 = getThreadContext(thread2);

      expect(context1.history.length).toBe(1);
      expect(context2.history.length).toBe(1);
      expect(context1.history[0].user).toBe('Color is blue');
      expect(context2.history[0].user).toBe('Color is red');
    });
  });

  describe('Context cleanup', () => {
    test('should clear all contexts', () => {
      addToThreadContext('thread-1', 'Hello', 'Hi');
      addToThreadContext('thread-2', 'Goodbye', 'Bye');

      clearThreadContext();

      // After clearing, new contexts should be empty
      const context1 = getThreadContext('thread-1');
      const context2 = getThreadContext('thread-2');

      expect(context1.history.length).toBe(0);
      expect(context2.history.length).toBe(0);
    });
  });
});
