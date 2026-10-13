import { execFile } from "child_process";

export function openLinuxBrowser(url: string): void {
  const commands = ["xdg-open", "gnome-open", "kde-open", "wslview"];
  let nextCommand = 0;
  const tryNext = (): void => {
    const command = commands[nextCommand++];
    if (!command) {
      console.warn(`Could not open browser automatically. Visit ${url}`);
      return;
    }
    execFile(command, [url], (error) => {
      if (error) tryNext();
    });
  };
  tryNext();
}
