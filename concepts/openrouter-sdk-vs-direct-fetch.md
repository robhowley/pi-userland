---
title: SDK vs Direct Fetch for /models/user
description: Clarification on SDK usage and mock complexity
date: Sun May 11 2026 11:00:00 GMT-0400 (Eastern Daylight Time)
aliases: openrouter-sdk-vs-direct-fetch
shared: false
---

# SDK vs Direct Fetch for `/models/user`

## Correction: SDK mocks are NOT complex

The previous explanation stated that SDK's `models.listForUser()` requires complex `Response` mocking, but this is **incorrect**.

### The SDK actually takes `request` objects

The SDK methods (`getCredits()`, `getUserActivity()`, `listForUser()`) all take `request` objects as parameters, not `Response` objects:

```typescript
// SDK methods (simplified)
client.credits.getCredits(request?: GetCreditsRequest): Promise<GetCreditsResponse>
client.analytics.getUserActivity(request?: GetUserActivityRequest): Promise<ActivityResponse>
client.models.listForUser(security, request?: ListModelsUserRequest): Promise<ModelsListResponse>
```

### Simple parameterized tests ARE possible

With the SDK, tests can be simple:

```typescript
it('handles 401 error', async () => {
  const mockResponse = { status: 401, json: async () => ({ error: { message: 'Invalid key' } }) };
  global.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

  await client.models.listForUser({ bearer: 'key' }, {});
  // Or whatever SDK method you're using
});
```

### Why direct fetch was actually chosen

**The real reason** for using direct fetch was:
1. **No existing usage**: The SDK's `models.listForUser()` was never used in the codebase
2. **Consistency**: Other SDK calls use `client.credits` and `client.analytics` - user-facing `/models/user` was new
3. **Simplicity**: Direct fetch is straightforward, but the SDK would require:
   - Setting up SDK client instance
   - Understanding SDK's internal authentication flow
   - Potential friction if SDK changes its internal implementation

### Current state

- `client.ts` uses **direct fetch** for `fetchUserModels()` - ✅
- `client.ts` uses **SDK** for `getCredits()` and `getActivity()` - ✅
- Both approaches work fine; choice was about code organization, not technical necessity

---

## Recommendation

**Either approach is fine** for user-facing endpoints. The choice should be based on:
- Codebase consistency (stick with what's already used)
- Future maintainability (SDK might add retry/backoff, but that's also true for direct fetch)
- Personal/team preference

For `/models/user`, direct fetch is simpler and already implemented. No need to change.