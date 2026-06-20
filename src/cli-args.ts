/**
 * Parsed options for the dashboard entrypoint.
 */
export interface DashboardArgs {
  /** Hostname or interface to bind the dashboard server to. */
  host: string;
  /** TCP port to listen on. */
  port: number;
  /** Whether the CLI should open the dashboard URL in the default browser. */
  shouldOpen: boolean;
}

function getArg(args: string[], name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

/**
 * Parse dashboard CLI flags and validate the optional port override.
 *
 * @param args Raw dashboard CLI arguments without the node executable prefix.
 * @returns Parsed dashboard host, port, and browser-open flag.
 * @throws {Error} When `--port` is missing a valid integer in the 1-65535 range.
 */
export function parseDashboardArgs(args: string[]): DashboardArgs {
  const rawPort = getArg(args, "--port", "3000");
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Error: --port must be a number between 1 and 65535. Got: "${rawPort}"`);
  }

  const port = Number.parseInt(rawPort, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`Error: --port must be a number between 1 and 65535. Got: "${rawPort}"`);
  }

  return {
    port,
    host: getArg(args, "--host", "localhost"),
    shouldOpen: args.includes("--open"),
  };
}
