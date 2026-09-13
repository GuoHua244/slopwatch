/**
 * argv helpers for the listener entry scripts, run as `bun <script> --flag value`.
 */
export const argvHelpers = (args: string[]) => {
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const numArg = (name: string, dflt: number): number => {
    const n = Number(arg(name));
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return { arg, numArg };
};
