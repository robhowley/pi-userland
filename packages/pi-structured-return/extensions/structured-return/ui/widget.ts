export function renderWidgetLine(command: string, summary: string): string[] {
  return [`structured_return ${command}`, `→ ${summary}`];
}
