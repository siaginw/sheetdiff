import Link from "next/link";
import { GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccountMenu } from "@/components/sheet/account-menu";
import { listMembers } from "@/lib/access";
import { smtpConfigured } from "@/lib/digest";
import type { User } from "@/lib/db/schema";

export async function AppHeader({ user }: { user: User | null }) {
  const memberList = user ? await listMembers(user.id) : [];
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <GitCompareArrows className="size-4" />
          </span>
          SheetDiff
        </Link>
        {user ? (
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" size="sm" render={<Link href="/sheets/new" />}>
              Add sheet
            </Button>
            <AccountMenu
              name={user.name}
              email={user.email}
              avatarUrl={user.avatarUrl ?? null}
              digestEmail={user.digestEmail}
              digestTime={user.digestTime ?? "07:00"}
              digestDay={user.digestDay ?? null}
              smtpReady={smtpConfigured()}
              members={memberList.map((m) => ({ id: m.id, email: m.email }))}
            />
          </div>
        ) : null}
      </div>
    </header>
  );
}
