/**
 * argv helpers for the listener entry scripts, run as `bun <script> --flag
 * value` or `bun <script> --flag=value`.
 */
export const argvHelpers = (args: string[]) => {
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    if (i >= 0) return args[i + 1];
    // also accept the --flag=value form — previously its value was lost
    const prefix = `--${name}=`;
    const withValue = args.find((a) => a.startsWith(prefix));
    return withValue ? withValue.slice(prefix.length) : undefined;
  };
  const numArg = (name: string, dflt: number): number => {
    const n = Number(arg(name));
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return { arg, numArg };
};
