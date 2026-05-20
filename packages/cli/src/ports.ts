export const DEFAULT_PORT = 4521;
export const DEFAULT_PORT_FALLBACK_ATTEMPTS = 20;

export function parsePort(value: string | undefined): number {
  const port = parseInt(value ?? "", 10);
  return Number.isNaN(port) ? DEFAULT_PORT : port;
}

export function hasExplicitPortArg(argv: string[]): boolean {
  return argv.some((arg, index) => {
    if (arg === "--port" || arg === "-p") return index < argv.length - 1;
    return arg.startsWith("--port=") || /^-p\d+$/.test(arg);
  });
}
