const launcherEnvironmentKeys = [
  "TMUX",
  "TMUX_PANE",
  "TMUX_TMPDIR",
  "PI_SUBAGENT_MANIFEST",
  "PI_PACKAGE_DIR",
] as const;

/** Keep launcher tests independent of the Pi/tmux process that started them. */
export function isolateLauncherEnvironment(): () => void {
  const inherited = new Map<string, string | undefined>(
    launcherEnvironmentKeys.map(key => [key, process.env[key]]),
  );
  for (const key of launcherEnvironmentKeys) delete process.env[key];
  return () => {
    for (const key of launcherEnvironmentKeys) {
      const value = inherited.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
