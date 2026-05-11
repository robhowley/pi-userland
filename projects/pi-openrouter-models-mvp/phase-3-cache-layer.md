---
title: Phase 3 - Cache Layer
description: Last-good cache for OpenRouter model data with file persistence at ~/.pi/openrouter
date: Sat May 09 2026 20:00:00 GMT-0400 (Eastern Daylight Time)
aliases: openrouter-models-phase-3
shared: false
---

# Phase 3: Cache Layer

**Status:** ✅ Complete

**Files Created:**
- `extensions/openrouter/models/cache.ts` - Core cache operations
- `extensions/openrouter/models/__tests__/cache.test.ts` - Unit tests

---

## Implementation Summary

### 3.1 Cache Module

**File:** `extensions/openrouter/models/cache.ts`

```typescript
const CACHE_FILENAME = "models-cache.json";
const CACHE_DIR = join(homedir(), ".pi", "openrouter");  // ~/.pi/openrouter/models-cache.json

export async function loadCache(): Promise<ModelsCache | null> { ... }
export async function saveCache(cache: ModelsCache): Promise<void> { ... }
export function getCacheAgeMs(cache: ModelsCache): number { ... }
export function formatCacheAge(cache: ModelsCache | null): string | null { ... }
```

**Cache Location:** `~/.pi/openrouter/models-cache.json`

### 3.2 Unit Tests

**File:** `extensions/openrouter/models/__tests__/cache.test.ts`

**Test Coverage:**
- ✅ Load: missing file, valid file, invalid JSON, invalid structure (4 tests)
- ✅ Save: creates valid file, overwrites existing file (2 tests)
- ✅ Age: milliseconds calculation, formatting (minutes/hours/days) (7 tests)

### 3.3 Acceptance Criteria

- [x] `extensions/openrouter/models/cache.ts` exists with all functions
- [x] `extensions/openrouter/models/__tests__/cache.test.ts` exists
- [x] Cache persistence tested:
  - [x] Returns null when file missing
  - [x] Returns parsed data when file exists and valid
  - [x] Returns null when JSON invalid
  - [x] Returns null when structure invalid
- [x] Cache save tested:
  - [x] Creates valid JSON file
  - [x] Overwrites existing file
- [x] Cache age tested:
  - [x] Calculates milliseconds correctly
  - [x] Formats minutes (< 1 hour)
  - [x] Formats hours (1-24 hours)
  - [x] Formats days (> 24 hours)
- [x] All tests pass (`pnpm test`) - 13 tests passed
- [x] TypeScript compiles without errors

---

## Cache Location

The cache is stored at `~/.pi/openrouter/models-cache.json` in the canonical Pi config directory, consistent with `local-usage.ts`.

---

## Navigation

← [[Phase 2: Model Mapping Logic]]  
→ [[Phase 4: API Client Extension]]
