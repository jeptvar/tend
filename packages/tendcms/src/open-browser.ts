import { spawn } from "node:child_process";

/**
 * Opens an address in this computer's browser, for `tendcms start --open`. Nothing here can
 * stop Tend: if there's no browser to open, the address printed above still works.
 */
export function openInBrowser(url: string): void {
  // Only Tend's own http(s) link ever comes here, and these characters would mean something
  // else to Windows' command line.
  if (!/^https?:\/\/[^\s"&|<>^%]+$/.test(url)) return;
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/d", "/c", "start", '""', `"${url}"`], {
            stdio: "ignore",
            detached: true,
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            stdio: "ignore",
            detached: true,
          });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser here, a server say: the link is printed for that.
  }
}
