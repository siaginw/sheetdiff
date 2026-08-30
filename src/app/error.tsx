"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-muted/30 px-4 text-center">
      <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">something broke</p>
      <h2 className="max-w-md text-balance text-xl font-semibold">
        That page hit an unexpected error — the data is safe on disk.
      </h2>
      <button
        onClick={reset}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  );
}
