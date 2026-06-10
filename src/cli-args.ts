export interface DashboardArgs {
  host: string;
  port: number;
  shouldOpen: boolean;
}

function getArg(args: string[], name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

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
