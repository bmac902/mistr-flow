import { execFile as defaultExecFile } from "node:child_process";

import { getConfigPath } from "./config";

export type BarContextMenuAction = "quit" | "open-config-file";

export interface BarContextMenuItem {
  id: BarContextMenuAction;
  label: string;
}

export interface BarContextMenu {
  items: BarContextMenuItem[];
}

export interface BarContextMenuDependencies {
  quit(): void | Promise<void>;
  openConfigFile(configPath: string): void | Promise<void>;
}

export type ExecFileLike = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: NodeJS.ErrnoException | null) => void,
) => void;

const defaultExecFileLike = defaultExecFile as unknown as ExecFileLike;

export function buildBarContextMenu(): BarContextMenu {
  return {
    items: [
      { id: "quit", label: "Quit" },
      { id: "open-config-file", label: "Open config file" },
    ],
  };
}

export async function runBarContextMenuAction(
  action: BarContextMenuAction,
  dependencies: BarContextMenuDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (action === "quit") {
    await dependencies.quit();
    return;
  }

  await dependencies.openConfigFile(getConfigPath(env));
}

export async function openConfigFileWithDefaultHandler(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
  execFile: ExecFileLike = defaultExecFileLike,
): Promise<void> {
  const command = getOpenCommand(platform);
  const args = getOpenCommandArgs(platform, configPath);

  await runExecFile(command, args, execFile);
}

function getOpenCommand(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "cmd";
  }

  if (platform === "darwin") {
    return "open";
  }

  return "xdg-open";
}

function getOpenCommandArgs(
  platform: NodeJS.Platform,
  configPath: string,
): ReadonlyArray<string> {
  if (platform === "win32") {
    return ["/c", "start", "", configPath];
  }

  return [configPath];
}

function runExecFile(
  file: string,
  args: ReadonlyArray<string>,
  execFile: ExecFileLike,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
