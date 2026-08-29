const LOG_CLOSE_TIMEOUT_MS = 2_000;
const LOG_CLOSE_TIMEOUT_MESSAGE = "[codesesh] Timed out closing application log; forcing exit\n";

export async function closeLoggerBeforeTermination(
  closeLogger: () => Promise<void>,
  exitCode: string | number,
): Promise<void> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    watchdog = setTimeout(() => resolve(false), LOG_CLOSE_TIMEOUT_MS);
  });

  try {
    const closed = await Promise.race([closeLogger().then(() => true as const), timedOut]);
    if (closed) return;
    try {
      process.stderr.write(LOG_CLOSE_TIMEOUT_MESSAGE);
    } finally {
      process.exit(exitCode);
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}
