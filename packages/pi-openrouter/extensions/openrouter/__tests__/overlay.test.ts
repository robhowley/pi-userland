import { describe, it, expect, afterEach } from 'vitest';
import { UsageOverlayComponent } from '../overlay.js';
import { createUsageSummary, createUsageAggregate } from './fixtures.js';
import type { Theme } from '@mariozechner/pi-coding-agent';

/**
 * Minimal identity theme for testing.
 * Returns text unchanged to simplify assertions.
 */
function createIdentityTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_style: string, text: string) => text,
  } as Theme;
}

/**
 * Test suite for overlay Today-row rendering safety net.
 *
 * These tests prove the fix for the Today-row / local-window mismatch bug.
 * The contract: the row labeled `Today` must render `summary.today`,
 * not `summary.local.cost` or `summary.local.requests`.
 */
describe('UsageOverlayComponent - Today row rendering', () => {
  const components: UsageOverlayComponent[] = [];

  afterEach(() => {
    // Dispose all components to prevent interval timer leaks
    for (const component of components) {
      component.dispose();
    }
    components.length = 0;
  });

  function createComponent(summary: ReturnType<typeof createUsageSummary>): UsageOverlayComponent {
    const component = new UsageOverlayComponent(
      summary,
      null, // no error
      null, // no cached age
      createIdentityTheme(),
      () => {}, // onClose
      () => {}, // requestRender
    );
    components.push(component);
    return component;
  }

  /**
   * Find the Today row line in rendered output.
   * Returns the line or null if not found.
   */
  function findTodayLine(lines: string[]): string | null {
    return lines.find((line) => line.includes('Today')) ?? null;
  }

  describe('Activity API absent / 30-day local fallback', () => {
    it.each([
      {
        label: 'local aggregate includes older + today usage',
        today: 0.5,
        localCost: 3.5,
        localRequests: 15,
        expectedTodayDisplay: 'Today ~$0.50',
        excludedAmount: '3.50',
      },
      {
        label: 'local aggregate is zero',
        today: 0,
        localCost: 0,
        localRequests: 0,
        expectedTodayDisplay: 'Today ~$0.00',
        excludedAmount: null,
      },
    ])(
      'renders Today using summary.today when $label',
      ({ today, localCost, localRequests, expectedTodayDisplay, excludedAmount }) => {
        const summary = createUsageSummary({
          today,
          hasActivityData: false,
          local: createUsageAggregate({
            cost: localCost,
            requests: localRequests,
          }),
          combined: createUsageAggregate({
            cost: localCost,
            requests: localRequests,
          }),
        });

        const component = createComponent(summary);
        const lines = component.render(120);
        const todayLine = findTodayLine(lines);

        expect(todayLine).toBeTruthy();
        expect(todayLine).toContain(expectedTodayDisplay);
        if (excludedAmount) {
          expect(todayLine).not.toContain(excludedAmount);
        }
        expect(todayLine).not.toContain('reqs');
      },
    );
  });

  describe('Activity API behind / local spans multiple post-official days', () => {
    it.each([
      {
        label: 'API through yesterday, local has yesterday + today',
        today: 2.0,
        week: 0,
        month: 0,
        officialThroughDate: '2026-05-24',
        officialCost: 10.0,
        officialRequests: 50,
        localCost: 4.0,
        localRequests: 20,
        combinedCost: 14.0,
        combinedRequests: 70,
        expectedTodayDisplay: 'Today ~$2.00',
        excludedAmount: '4.00',
      },
      {
        label: 'API 5 days behind, local has 5 days',
        today: 1.5,
        week: 15.0,
        month: 50.0,
        officialThroughDate: '2026-05-20',
        officialCost: 40.0,
        officialRequests: 200,
        localCost: 10.0,
        localRequests: 50,
        combinedCost: 50.0,
        combinedRequests: 250,
        expectedTodayDisplay: 'Today ~$1.50',
        excludedAmount: '10.00',
      },
    ])(
      'renders Today using summary.today when $label',
      ({
        today,
        week,
        month,
        officialThroughDate,
        officialCost,
        officialRequests,
        localCost,
        localRequests,
        combinedCost,
        combinedRequests,
        expectedTodayDisplay,
        excludedAmount,
      }) => {
        const summary = createUsageSummary({
          today,
          week,
          month,
          hasActivityData: true,
          officialThroughDate,
          official: createUsageAggregate({
            cost: officialCost,
            requests: officialRequests,
          }),
          local: createUsageAggregate({
            cost: localCost,
            requests: localRequests,
          }),
          combined: createUsageAggregate({
            cost: combinedCost,
            requests: combinedRequests,
          }),
        });

        const component = createComponent(summary);
        const lines = component.render(120);
        const todayLine = findTodayLine(lines);

        expect(todayLine).toBeTruthy();
        expect(todayLine).toContain(expectedTodayDisplay);
        expect(todayLine).not.toContain(excludedAmount);
        expect(todayLine).not.toContain('reqs');
      },
    );
  });

  describe('Activity API has today / local is empty', () => {
    it.each([
      {
        label: 'API includes today',
        today: 3.0,
        officialThroughDate: '2026-05-25',
        officialCost: 20.0,
        officialRequests: 100,
        expectedTodayDisplay: 'Today ~$3.00',
      },
    ])(
      'renders Today using summary.today when $label',
      ({ today, officialThroughDate, officialCost, officialRequests, expectedTodayDisplay }) => {
        const summary = createUsageSummary({
          today,
          hasActivityData: true,
          officialThroughDate,
          official: createUsageAggregate({
            cost: officialCost,
            requests: officialRequests,
          }),
          local: createUsageAggregate({
            cost: 0,
            requests: 0,
          }),
          combined: createUsageAggregate({
            cost: officialCost,
            requests: officialRequests,
          }),
        });

        const component = createComponent(summary);
        const lines = component.render(120);
        const todayLine = findTodayLine(lines);

        expect(todayLine).toBeTruthy();
        expect(todayLine).toContain(expectedTodayDisplay);
        expect(todayLine).not.toContain('reqs');
      },
    );
  });
});
