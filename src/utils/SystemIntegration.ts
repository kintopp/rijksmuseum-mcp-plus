import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const OPEN_COMMANDS: Record<string, [string, ...string[]]> = {
  win32: ["cmd", "/c", "start", ""],
  darwin: ["open"],
};

export class SystemIntegration {
  static async openInBrowser(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Refusing to open non-HTTP URL: ${url}`);
    }
    const [cmd, ...args] = OPEN_COMMANDS[process.platform] ?? ["xdg-open"];
    await execFileAsync(cmd, [...args, url]);
  }
}