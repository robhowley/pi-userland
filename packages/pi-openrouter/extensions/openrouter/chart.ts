/**
 * Bar chart rendering for daily spend data
 * @param byDay - Record mapping date strings (YYYY-MM-DD) to spend amounts
 * @param _width - Maximum width for the chart (including padding)
 * @returns Formatted ASCII bar chart string (for text-table row)
 */
export function renderSpendBarChart(byDay: Record<string, number>, _width: number): string {
  if (Object.keys(byDay).length === 0) {
    return 'No spend data';
  }

  // Find the date range from the data (use most recent 30 days worth of dates)
  const sortedKeys = Object.keys(byDay).sort();
  const latestDateStr = sortedKeys[sortedKeys.length - 1]!;
  
  // Parse date components (handle both YYYY-MM-DD and YYYY-MM-DDTHH:mm:ssZ)
  const dateMatch = latestDateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) {
    return 'Invalid date format';
  }
  
  // Build 30-day window ending on the latest date in the data
  const year = parseInt(dateMatch[1]!, 10);
  const month = parseInt(dateMatch[2]!, 10);
  const day = parseInt(dateMatch[3]!, 10);
  
  const values: number[] = [];
  const dates: string[] = [];
  
  // Generate 30 days of dates ending on latestDate
  for (let i = 29; i >= 0; i--) {
    const d = new Date(year, month - 1, day);
    d.setDate(d.getDate() - i);
    
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dayStr = String(d.getDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${dayStr}`;
    
    dates.push(dateKey);
    // Look up value in byDay (try exact match and time-suffixed variants)
    let value = byDay[dateKey];
    if (value === undefined) {
      // Try with time suffixes
      value = byDay[dateKey + 'T00:00:00Z'] ?? byDay[dateKey + ' 00:00:00'];
    }
    values.push(value ?? 0);
  }
  
  const max = Math.max(...values);
  
  if (max === 0) {
    return 'No spend';
  }

  // Build 9-row horizontal bar chart (top to bottom)
  // Each bar is 2 chars: "█ " (bar + breathing space)
  const chartHeight = 9;
  const valueStep = Math.ceil(max / chartHeight);
  const lines: string[] = [];
  const chartWidth = 30 * 2; // 30 bars with space between

  // Draw rows from top (highest value) to bottom (lowest - the x-axis)
  for (let row = chartHeight - 1; row >= 0; row--) {
    const rowValue = row * valueStep;
    const label = String(rowValue).padStart(3);
    
    let line = `${label} |`;
    
    // For each bar: fill if the bar's height reaches above current row
    // Add space after each bar for breathing room
    for (const v of values) {
      const barHeight = Math.ceil((v / max) * chartHeight);
      line += barHeight > row ? '█' : ' ';
      line += ' '; // Breathing space between bars
    }
    
    lines.push(line);
  }

  // Separator line - spans full width including spaces between bars
  lines.push('   +' + '─'.repeat(chartWidth));
  
  // Month label line - mark month changes
  const firstMonth = dates[0]!.slice(5, 7);
  const lastMonth = dates[dates.length - 1]!.slice(5, 7);
  
  let monthLine = '    ';
  // Find where month changes
  const monthChangeIndex = dates.findIndex((d, i) => i > 0 && d.slice(5, 7) !== firstMonth);
  
  if (firstMonth === lastMonth) {
    // All in one month - centered label
    const label = getMonthName(firstMonth);
    const padding = Math.floor((chartWidth - label.length) / 2);
    monthLine += ' '.repeat(padding) + label + ' '.repeat(chartWidth - padding - label.length);
  } else if (monthChangeIndex > 0) {
    // Month transition - show first month near start, second near end
    const firstLabel = getMonthName(firstMonth);
    const secondLabel = getMonthName(lastMonth);
    // Position labels: first at ~8 chars, second at ~52 chars
    const firstPos = 4;
    const secondPos = chartWidth - 8;
    monthLine += ' '.repeat(firstPos) + firstLabel + 
                 ' '.repeat(secondPos - firstPos - firstLabel.length) + secondLabel +
                 ' '.repeat(chartWidth - secondPos - secondLabel.length);
  }
  
  lines.push(monthLine.slice(0, 4 + chartWidth));
  
  // Day numbers line - show every 2-3 days, aligning with bar positions
  // Each day is at position i*2, so day 0=col0, day 5=col10, day 10=col20, etc
  let daysLine = '    ';
  for (let i = 0; i < 30; i++) {
    // Show day number at every bar position
    const dayNum = dates[i]!.slice(8, 10);
    if (i === 0 || i === 29 || i % 5 === 0) {
      // Place the 2-digit day number, it will take 2 chars which aligns perfectly
      daysLine += dayNum;
    } else {
      daysLine += '  ';
    }
  }
  lines.push(daysLine.slice(0, 4 + chartWidth));
  
  return lines.join('\n');
}

function getMonthName(mm: string): string {
  const months: Record<string, string> = {
    '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
    '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
    '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec'
  };
  return months[mm] ?? mm;
}

// Legacy export for backward compatibility
export function renderSpendSparkline(...args: Parameters<typeof renderSpendBarChart>): string[] {
  return [renderSpendBarChart(...args)];
}
