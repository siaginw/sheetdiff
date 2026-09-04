"use client";

import { DigestBody } from "@/components/sheet/digest-settings";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useState } from "react";

/** The digest settings on the Settings page — the same DigestBody the
 *  account menu mounts, with page-local open state. */
export function DigestSettingsSection({
  digestEmail,
  digestTime,
  digestDay,
  smtpReady,
  trigger,
}: {
  digestEmail: string | null;
  digestTime: string;
  digestDay: number | null;
  smtpReady: boolean;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ButtonLikeTrigger onClick={() => setOpen(true)}>{trigger}</ButtonLikeTrigger>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DigestBody
            digestEmail={digestEmail}
            digestTime={digestTime}
            digestDay={digestDay}
            smtpReady={smtpReady}
            onSaved={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ButtonLikeTrigger({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-left">
      {children}
    </button>
  );
}
