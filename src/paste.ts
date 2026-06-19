export interface PasteDependencies {
  writeClipboard(text: string): Promise<void> | void;
  simulatePaste(): Promise<void> | void;
}

export async function pasteText(
  text: string,
  dependencies: PasteDependencies,
): Promise<void> {
  await dependencies.writeClipboard(text);
  await dependencies.simulatePaste();
}
