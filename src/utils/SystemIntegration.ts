import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class SystemIntegration {
  static async openInBrowser(url: string): Promise<void> {
    const platform = process.platform;

    if (platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', url]);
      return;
    }

    if (platform === 'darwin') {
      await execFileAsync('open', [url]);
      return;
    }

    await execFileAsync('xdg-open', [url]);
  }
} 