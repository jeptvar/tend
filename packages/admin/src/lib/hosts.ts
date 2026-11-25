// Where the admin is open, which decides what's true to say about the site and the connection.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether the admin is open on the computer Tend runs on, which nobody else can reach. */
export function onThisComputer(): boolean {
  return LOCAL_HOSTS.has(window.location.hostname);
}

/** Whether what's typed here could be read on the way: plain http, to another computer. */
export function connectionIsOpen(): boolean {
  return window.location.protocol === "http:" && !onThisComputer();
}
