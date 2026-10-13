import { isIP } from "net";

/**
 * Format the URL printed by the dashboard CLI and passed to the browser.
 * @param host Dashboard host, including bare or bracketed IPv6 addresses.
 * @param port Dashboard port.
 * @returns An HTTP URL with brackets around bare IPv6 addresses.
 */
export function getDashboardUrl(host: string, port: number): string {
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}
