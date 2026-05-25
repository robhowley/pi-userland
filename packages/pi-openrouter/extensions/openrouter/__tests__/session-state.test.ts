import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionState } from '../session-state.js';
import type { SessionState } from '../session-state.js';
import { createSessionCtx, THROW_SESSION_ID } from './fixtures.js';

describe('SessionState', () => {
  describe('createSessionState', () => {
    it('should create a new session state instance', () => {
      const state = createSessionState();
      expect(state).toBeDefined();
      expect(typeof state.getCurrentSessionId).toBe('function');
      expect(typeof state.reset).toBe('function');
    });

    it('should produce different instances with different initial IDs', () => {
      const state1 = createSessionState();
      const state2 = createSessionState();

      const mockCtx = createSessionCtx('test-session-1');
      const mockCtx2 = createSessionCtx('test-session-2');

      const id1 = state1.getCurrentSessionId(mockCtx);
      const id2 = state2.getCurrentSessionId(mockCtx2);

      expect(id1).not.toBe(id2);
      expect(id1).toBe('pi:test-session-1');
      expect(id2).toBe('pi:test-session-2');
    });
  });

  describe('getCurrentSessionId', () => {
    let state: SessionState;

    beforeEach(() => {
      state = createSessionState();
    });

    it('should return the same ID on multiple calls within same session', () => {
      const mockCtx = createSessionCtx('stable-session');

      const id1 = state.getCurrentSessionId(mockCtx);
      const id2 = state.getCurrentSessionId(mockCtx);
      const id3 = state.getCurrentSessionId(mockCtx);

      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
      expect(id1).toBe('pi:stable-session');
    });

    it('should cache the session ID even if context changes', () => {
      const mockCtx1 = createSessionCtx('session-1');
      const mockCtx2 = createSessionCtx('session-2');

      const id1 = state.getCurrentSessionId(mockCtx1);
      // Second call with different context should return cached ID
      const id2 = state.getCurrentSessionId(mockCtx2);

      expect(id1).toBe(id2);
      expect(id1).toBe('pi:session-1');
    });

    it.each([
      ['empty string', ''],
      ['throwing manager', THROW_SESSION_ID],
    ])(
      'should generate stable fallback UUID when sessionManager returns %s',
      (_label, sessionIdOrMarker) => {
        const mockCtx = createSessionCtx(sessionIdOrMarker);

        const id1 = state.getCurrentSessionId(mockCtx);
        const id2 = state.getCurrentSessionId(mockCtx);

        expect(id1).toBe(id2);
        expect(id1).toMatch(
          /^pi:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      },
    );

    it('should format session ID with pi: prefix', () => {
      const mockCtx = createSessionCtx('my-session');

      const id = state.getCurrentSessionId(mockCtx);
      expect(id).toBe('pi:my-session');
    });

    it('should not double-prefix if session ID already starts with pi:', () => {
      const mockCtx = createSessionCtx('pi:already-prefixed');

      const id = state.getCurrentSessionId(mockCtx);
      expect(id).toBe('pi:already-prefixed');
      expect(id).not.toMatch(/^pi:pi:/);
    });
  });

  describe('reset', () => {
    let state: SessionState;

    beforeEach(() => {
      state = createSessionState();
    });

    it('should clear cached session ID', () => {
      const mockCtx1 = createSessionCtx('session-1');
      const mockCtx2 = createSessionCtx('session-2');

      const id1 = state.getCurrentSessionId(mockCtx1);
      expect(id1).toBe('pi:session-1');

      state.reset();

      const id2 = state.getCurrentSessionId(mockCtx2);
      expect(id2).toBe('pi:session-2');
      expect(id2).not.toBe(id1);
    });

    it('should allow new fallback UUID after reset', () => {
      const mockCtx = createSessionCtx('');

      const id1 = state.getCurrentSessionId(mockCtx);
      state.reset();
      const id2 = state.getCurrentSessionId(mockCtx);

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^pi:/);
      expect(id2).toMatch(/^pi:/);
    });
  });

  describe('peek', () => {
    let state: SessionState;

    beforeEach(() => {
      state = createSessionState();
    });

    it('should return null before first call to getCurrentSessionId', () => {
      expect(state.peek()).toBeNull();
    });

    it('should return cached session ID without initializing', () => {
      const mockCtx = createSessionCtx('my-session');

      state.getCurrentSessionId(mockCtx);
      expect(state.peek()).toBe('pi:my-session');
    });

    it('should return null after reset', () => {
      const mockCtx = createSessionCtx('my-session');

      state.getCurrentSessionId(mockCtx);
      expect(state.peek()).toBe('pi:my-session');

      state.reset();
      expect(state.peek()).toBeNull();
    });
  });

  describe('startSession', () => {
    let state: SessionState;

    beforeEach(() => {
      state = createSessionState();
    });

    it('should preserve cached ID when raw session ID is the same', () => {
      const mockCtx = createSessionCtx('stable-session');

      // Initialize with first call
      const id1 = state.getCurrentSessionId(mockCtx);
      expect(id1).toBe('pi:stable-session');

      // Call startSession with same raw ID
      state.startSession(mockCtx);

      // Should preserve the same ID
      const id2 = state.peek();
      expect(id2).toBe('pi:stable-session');
      expect(id2).toBe(id1);
    });

    it('should update ID when raw session ID changes', () => {
      const mockCtx1 = createSessionCtx('session-1');
      const mockCtx2 = createSessionCtx('session-2');

      // Initialize with first session
      const id1 = state.getCurrentSessionId(mockCtx1);
      expect(id1).toBe('pi:session-1');

      // Call startSession with different raw ID
      state.startSession(mockCtx2);

      // Should have new ID
      const id2 = state.peek();
      expect(id2).toBe('pi:session-2');
      expect(id2).not.toBe(id1);
    });

    it.each([
      ['empty string', ''],
      ['throwing manager', THROW_SESSION_ID],
    ])('should clear state when session manager returns %s', (_label, sessionIdOrMarker) => {
      const mockCtx1 = createSessionCtx('my-session');
      const mockCtx2 = createSessionCtx(sessionIdOrMarker);

      // Initialize with valid session
      state.getCurrentSessionId(mockCtx1);
      expect(state.peek()).toBe('pi:my-session');

      // Call startSession with fallback case
      state.startSession(mockCtx2);

      // Should have cleared state
      expect(state.peek()).toBeNull();

      // Next getCurrentSessionId should generate fresh fallback
      const newId = state.getCurrentSessionId(mockCtx2);
      expect(newId).toMatch(
        /^pi:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should create and cache ID when called before getCurrentSessionId', () => {
      const mockCtx = createSessionCtx('my-session');

      // Call startSession without prior getCurrentSessionId
      state.startSession(mockCtx);

      // Should have created a cached ID
      expect(state.peek()).toBe('pi:my-session');
    });
  });
});
