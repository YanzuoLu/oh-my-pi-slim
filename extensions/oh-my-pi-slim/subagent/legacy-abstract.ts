export function legacyRunAbstract(task: string): string {
  return `${Array.from(task).slice(0, 100).join("")}...`;
}
