import { Button } from "@/components/ui/button";
import { dismissOnboarding } from "@/lib/actions";
import { Check, Circle, Share2, Star, Table2, X } from "lucide-react";
import Link from "next/link";

export interface OnboardingStep {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  optional?: boolean;
  href: string;
  cta: string;
}

/**
 * The getting-started card — four steps to the full workflow, each step's
 * completion DERIVED from the database so it can never lie. It hides itself
 * when everything is done (or when dismissed — the X survives the "I know
 * what I'm doing" crowd).
 */
export function OnboardingCard({ steps, allDone }: { steps: OnboardingStep[]; allDone: boolean }) {
  if (allDone) return null;
  return (
    <section className="mb-6 rounded-xl border bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Get started</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Four steps to the full workflow — this card disappears when they&apos;re done.
          </p>
        </div>
        <form action={dismissOnboarding}>
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Hide getting started">
            <X className="size-4" />
          </Button>
        </form>
      </div>
      <ul className="mt-3 divide-y">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3 py-2.5">
            {step.done ? (
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-diff-add-bg text-diff-add-fg">
                <Check className="size-3" />
              </span>
            ) : (
              <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground/40" />
            )}
            <div className="min-w-0 flex-1">
              <p
                className={`text-sm ${step.done ? "text-muted-foreground line-through decoration-border" : "font-medium"}`}
              >
                {step.title}
                {step.optional && !step.done ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">(optional)</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>
            </div>
            {!step.done ? (
              <Button variant="outline" size="sm" className="shrink-0" render={<Link href={step.href} />}>
                {step.cta}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Icon per step — kept next to the card so titles stay plain strings. */
export const STEP_ICONS = { Table2, Star, Share2 } as const;
